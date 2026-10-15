---
title: "Jenkins 多配置项目自动发布 Python 服务"
excerpt: "推到 eu_release 后，FM_EU_Deploy 按节点备份 XXX API、切软链、再重启 Supervisor。发布稳定后触发同一视图里的集成测试，测试结果再推到群。"
category: "Reliability"
date: 2026-10-15
author:
  name: "Kaysen"
  role: "安全与可靠性"
---

Python 服务的运行目录不能直接指着 Jenkins 工作区。工作区下次构建会被覆盖，进程还指着它，就会跑到一半对不上的代码。发布要先把这一次的文件固定到节点本地的备份目录，再把软链切过去，然后 `supervisorctl restart`。

推送到发布分支会自动走这套流程。回滚要自己进对应任务，用 Build with Parameters 选一次历史版本再点 Build。软链改回那次备份，不重新拷贝工作区。任务是多配置项目，一个轴就是一台服务器，勾上按配置顺序执行，一台做完再做下一台。

`supervisorctl restart` 期间这台进程不可用。任务只保证逐台进行，重启前不会从网关摘流。

文中只把 Jenkins 域名换成了示例，端口和 `/jenkins` 上下文路径仍按线上写法。飞书 Webhook 和 Jenkins API Token 不写进任务脚本。

## 一次发布在做什么

```text
eu_release 推送
    → 仓库 Webhook，查询参数里带 token
    → Generic Webhook Trigger，ref 匹配 refs/heads/eu_release
    → 矩阵按节点顺序执行壳脚本
          新版本：备份工作区 → 软链指向新备份 → 重启 Supervisor
          回滚：软链指向选中的备份 → 重启 Supervisor
    → 父构建改显示名
    → 飞书卡片
    → 父构建稳定时触发 FM_EU_Integration_Test
    → 测试结果再推到群
```

列出版本、改显示名、发飞书，都在 Jenkins 控制器上。备份、软链、重启在被发布的那台机器上，路径是节点本地磁盘。

| 路径 | 作用 |
| --- | --- |
| `/data/sources/PROD-EU-XXX-API-repo` | 软链。Supervisor 的工作目录指这里 |
| `/data/jenkins/backups/PROD-EU-XXX-API-NEW-年_月_日_构建号` | 这一次构建的文件副本 |
| 仓库里的 `env_files/.env.eu` | 构建时复制成备份目录中的 `.env` |

备份目录以 `PROD-EU-XXX-API-NEW-` 开头。同一台机器的备份根目录里，不要再放名字互为前缀的项目，清理旧备份时会把它们算进去。

## 要装的插件

| 插件 | 用来做什么 |
| --- | --- |
| Matrix Project | 多配置项目。新版本 Jenkins 要单独装，旧版本在核心里 |
| Git | 拉代码 |
| Extended Choice Parameter | 回滚版本下拉框 |
| Generic Webhook Trigger | 接收仓库的 Push |
| Version Number | 生成 `NEW-年_月_日_构建号`，并把它设成构建显示名 |
| Post build script | 构建后动作里的 Execute scripts on Matrix |
| Credentials Binding | 把飞书 Webhook 注进环境变量 |

控制台要看壳脚本里的颜色，再装 AnsiColor。不装也不影响发布，只是日志里会看到转义符。

## 创建任务

新建任务，类型选**构建多配置项目**。任务名 `FM_EU_Deploy`。任务如果放在文件夹里，后面 Groovy 要用带文件夹的全名。

### 回滚版本

勾选参数化构建，增加 Extended Choice Parameter。

| 字段 | 值 |
| --- | --- |
| Name | `BUILD_VERSION` |
| Description | 请选择回滚的版本号 |
| Basic Parameter Types | Single Select |
| Number of Visible Items | 10 |
| Delimiter | `,` |
| Choose Source for Value | Groovy Script |
| Default Value | `构建最新代码` |

任务页左侧的 **Build with Parameters** 会打开这个下拉框，默认停在「构建最新代码」。Webhook 触发不带这个参数，壳脚本把空值当成新版本。

Groovy Script 在控制器上执行，只用来列出当前任务自己的成功构建。Script Security 打开时，到 In-process Script Approval 里批准 `Jenkins.get`、`getItemByFullName`、`getBuilds` 这几项。

```groovy
import jenkins.model.Jenkins
import hudson.model.Result

def currentJobName = "FM_EU_Deploy"

def job = Jenkins.get().getItemByFullName(currentJobName)
if (job == null) {
    return ["任务不存在: ${currentJobName}"]
}

// RunList 从新到旧。凑满 10 个就停，避免每次点构建都扫完整历史。
def builds = []
for (def run : job.getBuilds()) {
    if (builds.size() >= 10) {
        break
    }
    def name = run.getDisplayName()
    if (run.getResult() == Result.SUCCESS && name != null && name.startsWith("NEW-")) {
        builds.add(name)
    }
}

builds.add(0, "构建最新代码")
return builds
```

下拉框如果把整段返回值当成一个选项，改成 `return builds.join(",")`，分隔符仍用逗号。`NEW-` 开头这个条件会滤掉失败构建，也会滤掉显示名已经被改成 `ROLLBACK-` 的回滚构建。再退一次时，选的仍是原来那次 `NEW-` 版本。

### 拉取代码

源码管理选 Git。

| 字段 | 值 |
| --- | --- |
| Repository URL | 填仓库地址 |
| Credentials | 配置有拉取权限的 Credentials |
| Branches to build | `*/eu_release` |

这条生产任务的分支是 `eu_release`。Branches to build、Webhook 过滤、仓库里实际推送的分支，三处用同一个名字。写成 `release` 时，触发后检出的就不是 Webhook 那条分支。

### 只响应发布分支

构建触发器选 Generic Webhook Trigger。

| 字段 | 值 |
| --- | --- |
| Variable | `ref` |
| Expression | `$.ref` |
| Token | 与仓库 Webhook 的 token 相同 |
| Override Quiet Period | 勾选 |
| Optional filter → Text | `$ref` |
| Optional filter → Expression | `^refs/heads/eu_release$` |

Push 的 JSON 里，`ref` 一般是 `refs/heads/分支名`。GitHub、GitLab、Gitea 都是这个字段。过滤表达式匹配完整 ref `refs/heads/eu_release`，Branches to build 填 `*/eu_release`。两处是同一分支的两种写法。

Override Quiet Period 勾上之后，这次触发不等任务上的 Quiet Period，推送进来就排构建。

Print post content 和 Print contributed variables 在第一次对过滤条件时勾上，用来确认 `$ref` 的值。过滤稳定后关掉正文打印，构建日志里就少留一份仓库地址和提交说明。

同一个 token 可以给多个任务用，每个任务靠自己的分支过滤决定要不要跑。token 出现在 invoke 地址的查询参数里，访问日志能看到它。泄露之后，仓库 Webhook 和 Jenkins 任务一起换一对新的。

### 按节点顺序执行

Configuration Matrix 增加一个 Node/Label 轴。

| 字段 | 值 |
| --- | --- |
| Name | 轴的名字，例如 `node` |
| Node/Label | 每一项一台服务器，用节点名 |
| Run each configuration sequentially | 勾选 |

节点名本身就是 label。每一项只匹配一台机器。一个 label 背后有多台时，Jenkins 只会挑其中一台跑，集群里其余机器这次不会发布。

顺序执行时，前面的节点已经切完软链并重启，后面的节点失败，集群会短时间跑着两个版本。脚本不会把已经切过去的节点再切回来。

### 版本号

构建环境里增加 Create a formatted version number。

| 字段 | 值 |
| --- | --- |
| Environment Variable Name | `VERSION_NUMBER` |
| Version Number Format String | `NEW-${BUILD_YEAR}_${BUILD_MONTH}_${BUILD_DAY}_${BUILD_NUMBER}` |
| Skip Builds worse than | SUCCESS |
| Build Display Name | 勾选，用格式化版本号作为构建显示名 |
| Project Start Date | 1970-01-01 |

格式串只用日历日期和 Jenkins 的 `BUILD_NUMBER`。Project Start Date 填 `1970-01-01` 即可，这个格式用不到它。Skip Builds worse than 影响的是插件自己的计数，例如 `BUILDS_ALL_TIME`。`BUILD_NUMBER` 在失败时仍然往上加。回滚列表不看这个计数，只收结果为成功、显示名以 `NEW-` 开头的父构建。

壳脚本里的备份目录名用的是 `BUILD_DISPLAY_NAME`。Version Number 作为构建环境包装器，会在壳脚本开始前把显示名设成 `NEW-...`，所以备份目录能拿到这个名字。

## 节点上的发布脚本

构建步骤增加 Execute shell。脚本在轴选中的那台机器上跑。执行用户要能写 `/data/jenkins/backups` 和 `/data/sources`，并且能执行 `supervisorctl`。节点是 Linux，用的是 GNU `head` 和 GNU `sed`。

新版本和回滚的分界只有两个：参数为空，或者参数等于 `构建最新代码`。选了任意一个 `NEW-` 版本，就回滚到对应备份。参数恰好等于磁盘上最新一份备份时，同样按回滚处理，软链指回那份目录。

回滚目录不存在就退出。软链失败也退出。避免目录缺失时仍然去重启服务。

壳脚本里给 `BUILD_DISPLAY_NAME` 赋值，只影响当前这个 shell，不会写回 Jenkins 的构建显示名。显示名放到后面的 Groovy 里改。发布脚本也不需要 Jenkins 用户名和 API Token，控制器上的 Groovy 直接用任务自己的权限。

```bash
#!/bin/bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# 按环境修改。认证信息放在 Jenkins Credentials 里，不要写进脚本。
PROJECT_NAME="PROD-EU-XXX-API"
SUPERVISOR_SERVICE="XXX-API"
BACKUP_ROOT="/data/jenkins/backups"
TARGET_LINK="/data/sources/${PROJECT_NAME}-repo"
ENV_FILE="${WORKSPACE}/env_files/.env.eu"
KEEP="${KEEP:-20}"
LATEST_OPTION="构建最新代码"

SELECTED_BUILD_VERSION="$(printf '%s' "${BUILD_VERSION:-}" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
CLEANED_BUILD_VERSION="${SELECTED_BUILD_VERSION//#/}"

if [[ ! ${KEEP} =~ ^[0-9]+$ ]] || [[ ${KEEP} -lt 1 ]]; then
    echo -e "${RED}KEEP 必须是正整数，当前值: ${KEEP}${NC}"
    exit 1
fi

case "${TARGET_LINK}" in
    /data/sources/*) ;;
    *)
        echo -e "${RED}TARGET_LINK 必须位于 /data/sources/ 下，当前值: ${TARGET_LINK}${NC}"
        exit 1
        ;;
esac

mkdir -p "${BACKUP_ROOT}" || {
    echo -e "${RED}无法创建 ${BACKUP_ROOT}${NC}"
    exit 1
}
mkdir -p "$(dirname "${TARGET_LINK}")" || {
    echo -e "${RED}无法创建 $(dirname "${TARGET_LINK}")${NC}"
    exit 1
}

BACKUP_DIR=""
ROLLBACK_DIR=""

if [[ -z ${SELECTED_BUILD_VERSION} || ${SELECTED_BUILD_VERSION} == "${LATEST_OPTION}" ]]; then
    VERSION_NAME="${BUILD_DISPLAY_NAME:-${VERSION_NUMBER:-}}"
    if [[ -z ${VERSION_NAME} ]]; then
        echo -e "${RED}BUILD_DISPLAY_NAME 为空。检查 Version Number 是否已把格式化版本号设为构建显示名。${NC}"
        exit 1
    fi

    BACKUP_DIR="${BACKUP_ROOT}/${PROJECT_NAME}-${VERSION_NAME}"
    echo -e "${GREEN}新版本构建，备份到 ${BACKUP_DIR}${NC}"
    mkdir -p "${BACKUP_DIR}" || {
        echo -e "${RED}无法创建 ${BACKUP_DIR}${NC}"
        exit 1
    }

    # 通配符 * 不包含点文件，.git 不会进备份。
    shopt -s nullglob
    files=("${WORKSPACE}/"*)
    if [[ ${#files[@]} -eq 0 ]]; then
        echo -e "${YELLOW}工作区没有可备份的普通文件${NC}"
    else
        cp -r "${files[@]}" "${BACKUP_DIR}/" || {
            echo -e "${RED}复制备份失败${NC}"
            exit 1
        }
    fi
    shopt -u nullglob

    if [[ -f ${ENV_FILE} ]]; then
        cp "${ENV_FILE}" "${BACKUP_DIR}/.env"
        echo -e "${GREEN}已写入 ${BACKUP_DIR}/.env${NC}"
    else
        echo -e "${YELLOW}未找到 ${ENV_FILE}，跳过 .env${NC}"
    fi

    echo -e "${GREEN}保留最近 ${KEEP} 份 ${PROJECT_NAME} 备份${NC}"
    while IFS= read -r dir; do
        [[ -n ${dir} ]] || continue
        rm -rf "${BACKUP_ROOT}/${dir}"
        echo -e "${GREEN}已删除旧备份 ${dir}${NC}"
    done < <(ls -1tr "${BACKUP_ROOT}" | grep "^${PROJECT_NAME}-NEW-" | head -n "-${KEEP}")
else
    ROLLBACK_DIR="${BACKUP_ROOT}/${PROJECT_NAME}-${CLEANED_BUILD_VERSION}"
    echo -e "${GREEN}回滚到 ${ROLLBACK_DIR}${NC}"
    if [[ ! -d ${ROLLBACK_DIR} ]]; then
        echo -e "${RED}回滚目录不存在: ${ROLLBACK_DIR}${NC}"
        exit 1
    fi
fi

# 路径末尾不要加斜杠，否则 rm 会顺着软链删进备份目录。
if [[ -L ${TARGET_LINK} || -e ${TARGET_LINK} ]]; then
    rm -rf "${TARGET_LINK}" || {
        echo -e "${RED}无法删除 ${TARGET_LINK}${NC}"
        exit 1
    }
fi

if [[ -n ${ROLLBACK_DIR} ]]; then
    ln -s "${ROLLBACK_DIR}" "${TARGET_LINK}" || {
        echo -e "${RED}软链失败: ${ROLLBACK_DIR}${NC}"
        exit 1
    }
    echo -e "${GREEN}软链 ${TARGET_LINK} -> ${ROLLBACK_DIR}${NC}"
else
    ln -s "${BACKUP_DIR}" "${TARGET_LINK}" || {
        echo -e "${RED}软链失败: ${BACKUP_DIR}${NC}"
        exit 1
    }
    echo -e "${GREEN}软链 ${TARGET_LINK} -> ${BACKUP_DIR}${NC}"
fi

# 非 search 节点把连接数阈值从 7000 调到 4000。检索节点另建任务，不要套用这段 sed。
# 回滚时也会改备份目录里的文件；已经是 4000 时，替换不会再生效一次。
WATCHDOG_SCRIPT="${TARGET_LINK}/scripts/system/conn_watchdog.sh"
if [[ -f ${WATCHDOG_SCRIPT} ]]; then
    sed -i 's/TOTAL_THRESHOLD=7000/TOTAL_THRESHOLD=4000/' "${WATCHDOG_SCRIPT}" || {
        echo -e "${RED}更新连接数阈值失败${NC}"
        exit 1
    }
    echo -e "${GREEN}已将 TOTAL_THRESHOLD 从 7000 调整为 4000${NC}"
else
    echo -e "${YELLOW}未找到 ${WATCHDOG_SCRIPT}，跳过阈值修改${NC}"
fi

supervisorctl restart "${SUPERVISOR_SERVICE}" || {
    echo -e "${RED}重启 ${SUPERVISOR_SERVICE} 失败${NC}"
    exit 1
}
echo -e "${GREEN}已重启 ${SUPERVISOR_SERVICE}${NC}"
```

`KEEP` 可以在任务的环境变量里覆盖，不写就是 20。`head -n -20` 会丢掉最新的 20 行，前面剩下的才是要删的旧备份。份数不够 20 时，这条管道没有输出，循环不执行。

点文件不会进备份。环境文件只从 `env_files/.env.eu` 复制成备份目录里的 `.env`。虚拟环境放在节点上的固定路径，由 Supervisor 使用，不要打进这份副本。脚本里没有 `pip install`。依赖要么已经在仓库里，要么由进程自己的启动脚本安装。

回滚不会用仓库里现在的 `env_files`，用的是那次备份里留下的代码和 `.env`。

`TOTAL_THRESHOLD` 是非 search 节点上的覆盖，从 7000 改成 4000。文件不存在只告警，避免旧版本仓库里还没有这个脚本时把发布打断。文件存在但 `sed` 失败，则中止这一台。

## 构建后更新显示名

构建后操作增加 Execute scripts on Matrix，放在飞书通知前面。父构建的显示名在通知脚本里会被读走，顺序反了，卡片上还是本次的 `NEW-` 编号。

| 字段 | 值 |
| --- | --- |
| If build was | 全选。失败时也要改显示名 |
| Execution is limited to | Master，也就是控制器 |
| Matrix target | MATRIX，只跑父构建 |

子构建的显示名仍由 Version Number 设成这次的 `NEW-...`。父构建在新版本时与第一台子构建对齐。回滚时父构建改成 `ROLLBACK-` 加上选中的版本，并去掉其中的 `NEW-`。选中 `NEW-2026_10_01_10` 时，父构建显示名是 `ROLLBACK-2026_10_01_10`。列表里能看出退回了哪一次。这次构建自己的 `NEW-` 编号没有对应备份目录，不能拿它当回滚目标。

```groovy
import hudson.matrix.MatrixBuild
import java.util.logging.Level
import java.util.logging.Logger

if (build instanceof MatrixBuild) {
    def matrixBuild = build as MatrixBuild
    def buildVersion = matrixBuild.getBuildVariables()?.get("BUILD_VERSION")
    if (buildVersion != null) {
        buildVersion = buildVersion.trim()
    }
    def isRollback = buildVersion && buildVersion != "构建最新代码"

    def runs = matrixBuild.getExactRuns()
    if (runs == null || runs.isEmpty()) {
        println "没有子构建，跳过显示名更新"
    } else if (isRollback) {
        def source = buildVersion.replace("#", "").replace("NEW-", "")
        def displayName = "ROLLBACK-${source}"
        matrixBuild.setDisplayName(displayName)
        println "回滚构建，父构建显示名: ${displayName}"
    } else {
        def listener = new hudson.util.LogTaskListener(Logger.getLogger("matrix-display-name"), Level.INFO)
        def displayName = null
        try {
            displayName = runs.get(0).getEnvironment(listener)?.get("BUILD_DISPLAY_NAME")
        } catch (Exception e) {
            println "读取第一台子构建的显示名失败: ${e.message}"
        }
        if (displayName) {
            matrixBuild.setDisplayName(displayName)
            println "新版本构建，父构建显示名: ${displayName}"
        } else {
            println "第一台子构建没有 BUILD_DISPLAY_NAME"
        }
    }
} else {
    println "当前构建不是矩阵父构建，跳过显示名更新"
}
```

## 飞书通知

再增加一段 Execute scripts on Matrix，放在改显示名之后。结果条件同样全选，执行位置选控制器，Matrix target 选 MATRIX。

Webhook 地址不要写进脚本。用 Credentials Binding 增加一个 Secret text，变量名 `FEISHU_WEBHOOK_URL`，值是飞书机器人的完整地址。变量没注入时，这段脚本只打日志，构建结果保持原样。通知发送失败同样只打日志，不把一次已经成功的发布改成失败。

卡片标题会去掉视图名里的「发布」，并去掉任务名末尾的 `_Deploy`。视图是「生产环境发布」，任务是 `FM_EU_Deploy`，标题就是「生产环境 - FM_EU - 构建成功」。

子构建结果取最差的一档。有失败或中止时，卡片为红色，父构建结果降到失败或中止。不稳定用橙色。全部成功才是绿色。只判断了失败、再把其余情况写成成功，会把中止的节点算成成功。`setResult` 只能把结果往更差改，不能把已经失败的父构建改回成功。

```groovy
import hudson.matrix.MatrixBuild
import hudson.matrix.MatrixRun
import hudson.model.Result
import hudson.scm.ChangeLogSet
import groovy.json.JsonOutput
import java.net.HttpURLConnection
import java.text.SimpleDateFormat

def userCause = build.getCause(hudson.model.Cause$UserIdCause)
def username = userCause != null ? userCause.getUserName() : "webhook"

def sendFeishuCard(String webhookUrl, String title, String message, String template) {
    def data = [
        msg_type: "interactive",
        card: [
            config: [wide_screen_mode: true],
            header: [
                title: [tag: "plain_text", content: title],
                template: template
            ],
            elements: [
                [tag: "markdown", content: message]
            ]
        ]
    ]

    def connection = new URL(webhookUrl).openConnection() as HttpURLConnection
    connection.setRequestMethod("POST")
    connection.setDoOutput(true)
    connection.setConnectTimeout(5000)
    connection.setReadTimeout(5000)
    connection.setRequestProperty("Content-Type", "application/json")
    connection.outputStream.withWriter("UTF-8") { writer ->
        writer << JsonOutput.toJson(data)
    }

    def responseCode = connection.responseCode
    if (responseCode == 200) {
        println "飞书通知已发送"
    } else {
        println "飞书通知失败，响应代码: ${responseCode}"
    }
}

def convertShortCodeToEmoji(String msg) {
    def emojiMap = [
        ":art:": "🎨",
        ":bug:": "🐛",
        ":sparkles:": "✨",
        ":fire:": "🔥",
        ":rocket:": "🚀",
        ":memo:": "📝",
        ":lipstick:": "💄",
        ":tada:": "🎉",
        ":white_check_mark:": "✅",
        ":lock:": "🔒",
        ":ambulance:": "🚑",
        ":construction:": "🚧"
    ]
    emojiMap.each { shortCode, emoji ->
        msg = msg.replace(shortCode, emoji)
    }
    return msg
}

def getChangeLogSummary(currentBuild, jobName, viewName, jenkinsBase) {
    def changeLog = ""
    def changeCount = 0
    def maxChanges = 5
    def encodedView = URLEncoder.encode(viewName, "UTF-8").replace("+", "%20")
    def changesUrl = "${jenkinsBase}/view/${encodedView}/job/${jobName}/changes"
    def dateFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss")

    def changeSets = currentBuild.getChangeSets()
    if (changeSets != null) {
        changeSets.reverseEach { ChangeLogSet changeSet ->
            changeSet.items.reverseEach { entry ->
                if (changeCount < maxChanges) {
                    def author = entry.getAuthor()?.fullName ?: "未知作者"
                    def commitMsg = convertShortCodeToEmoji(entry.getMsg() ?: "无提交消息")
                    def dateStr = dateFormat.format(new Date(entry.getTimestamp()))
                    changeLog += "- **时间**: ${dateStr} - **修改人**: ${author} - **提交消息**: ${commitMsg}\n"
                    changeCount++
                }
            }
        }
    }

    if (changeCount == 0) {
        return "- **无修改记录**\n"
    }
    if (changeCount >= maxChanges) {
        changeLog += "- [查看更多修改记录](${changesUrl})\n"
    }
    return changeLog
}

if (build instanceof MatrixBuild) {
    def matrixBuild = build as MatrixBuild
    def listener = new hudson.util.LogTaskListener(
        java.util.logging.Logger.getLogger("matrix-feishu"),
        java.util.logging.Level.INFO
    )
    def webhookUrl = null
    try {
        webhookUrl = matrixBuild.getEnvironment(listener)?.get("FEISHU_WEBHOOK_URL")
    } catch (Exception e) {
        println "读取 FEISHU_WEBHOOK_URL 失败: ${e.message}"
    }

    if (!webhookUrl) {
        println "未配置 FEISHU_WEBHOOK_URL，跳过飞书通知"
    } else {
        def jobName = matrixBuild.getParent().getDisplayName()
        def viewName = "生产环境发布"
        def jenkinsBase = "http://jenkins.example.com:8080/jenkins"
        def buildDisplayName = matrixBuild.getDisplayName()
        def buildTime = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date())
        def resultsSummary = [:]

        matrixBuild.getExactRuns().each { MatrixRun run ->
            def nodeName = run.getParent().getCombination().values().join(",")
            def result = run.getResult() ?: Result.FAILURE
            resultsSummary[nodeName] = result
        }

        if (resultsSummary.isEmpty()) {
            println "没有找到有效的构建节点"
        } else {
            def maxNodes = 3
            def nodeCount = 0
            def notificationMessage = ""
            def encodedView = URLEncoder.encode(viewName, "UTF-8").replace("+", "%20")
            def jobUrl = "${jenkinsBase}/view/${encodedView}/job/${jobName}"

            resultsSummary.each { nodeName, result ->
                if (nodeCount < maxNodes) {
                    println "节点: ${nodeName} - 构建结果: ${result}"
                    notificationMessage += "- **节点:** ${nodeName} - 构建结果: ${result}\n"
                    nodeCount++
                }
            }
            if (resultsSummary.size() > maxNodes) {
                notificationMessage += "- [查看更多节点信息](${jobUrl})\n"
            }

            def worst = Result.SUCCESS
            resultsSummary.values().each { result ->
                if (result.isWorseThan(worst)) {
                    worst = result
                }
            }
            if (worst.isWorseThan(Result.SUCCESS)) {
                matrixBuild.setResult(worst)
            }

            def overallResult = "构建成功"
            def template = "Green"
            if (worst == Result.UNSTABLE) {
                overallResult = "构建不稳定"
                template = "Orange"
            } else if (worst.isWorseThan(Result.SUCCESS)) {
                overallResult = "构建失败"
                template = "Red"
            }
            println "总体构建结果: ${overallResult}"

            def title = "🤖 ${viewName.replace('发布', '')} - ${jobName.replace('_Deploy', '')} - ${overallResult}"
            notificationMessage += "<hr>\n"
            notificationMessage += getChangeLogSummary(matrixBuild, jobName, viewName, jenkinsBase)
            notificationMessage += "<hr>\n"
            notificationMessage += "- **构建用户**: ${username}\n"
            notificationMessage += "- **构建版本**: ${buildDisplayName}\n"
            notificationMessage += "- **推送时间**: ${buildTime}\n"

            try {
                sendFeishuCard(webhookUrl, title, notificationMessage, template)
            } catch (Exception e) {
                println "飞书通知异常: ${e.message}"
            }
        }
    }
} else {
    println "当前构建不是矩阵父构建，跳过飞书通知"
}
```

变更记录取父构建的 changelog，最多 5 条，Gitmoji 短代码换成 emoji。矩阵任务的变更在父构建上。节点超过 3 台时，卡片里只列 3 台，其余用链接指回任务页。视图名含中文，链接里做了 URL 编码。

手动点击构建时，用户来自 `UserIdCause`。Webhook 触发没有这个 Cause，卡片上写 `webhook`。

## 仓库里的 Webhook

仓库的 Webhook 只勾选 Push events。地址和任务里的 token 一致。Jenkins 挂在 `:8080/jenkins` 下，invoke 路径要带上这段前缀，域名换成自己的：

```text
http://jenkins.example.com:8080/jenkins/generic-webhook-trigger/invoke?token=<webhook-token>
```

推送到 `eu_release` 之后，过滤条件通过，矩阵开始按节点发布。推到别的分支，`ref` 对不上，任务不会启动。

## 发布、回滚和失败时的状态

自动发布不经过参数页。Webhook 进来时 `BUILD_VERSION` 为空。每台机器把当前工作区拷到新的 `PROD-EU-XXX-API-NEW-...` 目录，软链切过去，再重启。父构建显示名就是这个 `NEW-` 版本号。

回滚只走手动构建。Dashboard 里打开对应视图，点进要回滚的那一项任务，例如生产环境的 `FM_EU_Deploy`。任务页左侧点 **Build with Parameters**。`BUILD_VERSION` 下拉框选择要退回的版本，再点 **Build**，回滚才开始。

```text
打开对应任务
    → Build with Parameters
    → 下拉选择一次 NEW- 版本
    → Build
    → 软链指向该备份 → 重启 Supervisor
```

下拉框第一项是「构建最新代码」，后面是这个任务最近 10 次成功、显示名以 `NEW-` 开头的构建。选「构建最新代码」再点 Build，会按当前仓库再发一版。选中某个 `NEW-` 之后，每台机器把软链指到自己磁盘上的那份备份，然后重启。这一次不拷贝当前工作区，也不覆盖那份备份。

这台机器如果没参与过那次构建，备份目录不存在，这一台失败退出，后面的节点也不再继续。已经切完的前面几台保持新软链。

回滚成功后，父构建显示名变成 `ROLLBACK-` 开头。下一次再点 Build with Parameters，下拉框里没有这次回滚记录。要再退，还是选原来的 `NEW-` 版本。

Supervisor 的 `directory` 或启动命令指向 `/data/sources/PROD-EU-XXX-API-repo`。重启之后进程看到的就是软链另一端的那份备份。

## 同一视图里的上下游

集成测试任务和 `FM_EU_Deploy` 放在同一个视图「生产环境发布」。下文把测试任务写成 `FM_EU_Integration_Test`，名字按实际任务改。

Dashboard 打开这个视图，左侧有 **Project Relationship**（项目关系）。上游项目填 `FM_EU_Deploy`，下游项目填 `FM_EU_Integration_Test`，点 Compare。这一页用指纹把上游的某次构建和下游用到它的构建排在一起。两边没有记录同一份文件的指纹时，页面提示没有连接这两项任务的指纹记录。

让发布结束去跑测试，配在发布任务的构建后操作里。项目关系这一页只做对照，不保存触发关系。

### 发布稳定后触发集成测试

在 `FM_EU_Deploy` 上增加 **Build other projects**（构建其他工程），放在飞书通知后面。

| 字段 | 值 |
| --- | --- |
| Projects to build | `FM_EU_Integration_Test` |
| Trigger only if build is stable | 勾选。只在父构建结果为成功时触发 |

飞书那段 Groovy 会把失败或中止收成父构建的最终结果。构建其他工程放在它后面，读到的才是这个结果。放在前面时，矩阵结果还没改，失败的发布也会把测试拉起来。

测试任务上不要再勾 **Build after other projects are built**（其他工程构建后触发）去看 `FM_EU_Deploy`。上游和下游各配一次，同一次发布会把测试跑两遍。

测试任务打开配置，高级里勾选 **Block build when upstream project is building**（当上游项目正在构建时阻止构建）。上一轮测试还在跑、新的发布又成功时，测试会等这一轮上游结束再开始。

回滚只要父构建是成功，同样会触发 `FM_EU_Integration_Test`。

保存之后，`FM_EU_Deploy` 的任务页列出下游项目，测试任务页列出上游项目。

指纹用来让「项目关系」对得上构建号。发布任务在构建后操作里 Archive the artifacts，把工作区里的版本文件存档并勾选指纹。测试任务记录同一份文件的指纹。触发测试本身不依赖这条指纹。

### 测试完把结果推到群

测试任务单独的构建后操作发飞书卡片。发布卡片只表示发布结果。群和发布通知不是同一个时，Secret text 用另一个变量 `FEISHU_TEST_WEBHOOK_URL`。同一个群就沿用 `FEISHU_WEBHOOK_URL`。

测试任务一般不是矩阵任务，脚本直接读当前构建。装了 JUnit 插件时，卡片里带上失败、跳过和总计。

```groovy
import hudson.model.Result
import groovy.json.JsonOutput
import java.net.HttpURLConnection
import java.text.SimpleDateFormat

def listener = new hudson.util.LogTaskListener(
    java.util.logging.Logger.getLogger("integration-test-feishu"),
    java.util.logging.Level.INFO
)
def env = build.getEnvironment(listener)
def webhookUrl = env?.get("FEISHU_TEST_WEBHOOK_URL") ?: env?.get("FEISHU_WEBHOOK_URL")

if (!webhookUrl) {
    println "未配置飞书 Webhook，跳过测试结果通知"
} else {
    def result = build.getResult() ?: Result.FAILURE
    def passed = result == Result.SUCCESS
    def title = passed ? "🤖 生产环境 - FM_EU 集成测试 - 通过" : "🤖 生产环境 - FM_EU 集成测试 - 失败"
    def time = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date())
    def message = "- **结果**: ${result}\n"
    message += "- **任务**: ${build.getParent().getFullDisplayName()} #${build.getNumber()}\n"
    message += "- **时间**: ${time}\n"

    def testAction = build.getActions().find { it.class.name == "hudson.tasks.junit.TestResultAction" }
    if (testAction != null) {
        message += "- **用例**: 失败 ${testAction.failCount}，跳过 ${testAction.skipCount}，总计 ${testAction.totalCount}\n"
    }
    if (env?.get("BUILD_URL")) {
        message += "- [打开构建](${env.get('BUILD_URL')})\n"
    }

    def data = [
        msg_type: "interactive",
        card: [
            config: [wide_screen_mode: true],
            header: [
                title: [tag: "plain_text", content: title],
                template: passed ? "Green" : "Red"
            ],
            elements: [
                [tag: "markdown", content: message]
            ]
        ]
    ]

    try {
        def connection = new URL(webhookUrl).openConnection() as HttpURLConnection
        connection.setRequestMethod("POST")
        connection.setDoOutput(true)
        connection.setConnectTimeout(5000)
        connection.setReadTimeout(5000)
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.withWriter("UTF-8") { writer ->
            writer << JsonOutput.toJson(data)
        }
        println connection.responseCode == 200 ? "测试结果已推送到群" : "推送失败，响应代码: ${connection.responseCode}"
    } catch (Exception e) {
        println "推送测试结果异常: ${e.message}"
    }
}
```

结果条件全选，失败时也推。通知失败只打日志，不改测试任务本身的结果。
