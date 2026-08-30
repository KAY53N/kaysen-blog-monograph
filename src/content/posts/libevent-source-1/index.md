---
title: "libevent 源码分析（一）"
excerpt: "libevent 是基于事件通知的库，用来替换事件驱动网络服务里的事件循环。程序调用 event_dispatch()，再动态增删事件，不必改循环本身。"
category: "Engineering"
date: 2025-01-23
author:
  name: "Kaysen"
  role: "安全与可靠性"
---

`libevent` 是一个基于事件通知机制的库，用来替换事件驱动网络服务器里的事件循环。应用程序只要调用 `event_dispatch()`，再动态添加或删除事件，不必改事件循环。

- 事件驱动，高性能
- 统一事件源
- 线程安全
- 轻量级，专注于网络
- 支持多种 I/O 多路复用：epoll、poll、dev/poll、select、kqueue 等
- 跨平台：Windows、Linux、macOS 等

使用 `libevent` 的程序：

- Chromium
- Memcached
- tmux
- Tor
- Crawl
- nginx

```
git clone https://github.com/libevent/libevent
```

API 及调用顺序：

1. `event_base()` 初始化 `event_base`
2. `evconnlistener_new_bind()` 建立 listen 事件
4. `event_add()` 把 event 加到事件链表上，注册事件
5. `event_base_dispatch()` 循环、检测、分发事件

```c
int
main(int argc, char **argv)
{
    struct event_base *base;
    struct evconnlistener *listener;
    struct event *signal_event;

    struct sockaddr_in sin = {0};
#ifdef _WIN32
    WSADATA wsa_data;
    WSAStartup(0x0201, &wsa_data);
#endif
        // 创建event_base
    base = event_base_new();
    if (!base) {
        fprintf(stderr, "Could not initialize libevent!\n");
        return 1;
    }

    sin.sin_family = AF_INET;
    sin.sin_port = htons(PORT);

        // //建立listen事件，aceept成功则调用listener_cb
    listener = evconnlistener_new_bind(base, listener_cb, (void *)base,
        LEV_OPT_REUSEABLE|LEV_OPT_CLOSE_ON_FREE, -1,
        (struct sockaddr*)&sin,
        sizeof(sin));

    if (!listener) {
        fprintf(stderr, "Could not create a listener!\n");
        return 1;
    }

        // 进行信号事件注册
    signal_event = evsignal_new(base, SIGINT, signal_cb, (void *)base);

    if (!signal_event || event_add(signal_event, NULL)<0) {
        fprintf(stderr, "Could not create/add a signal event!\n");
        return 1;
    }

        // 事件循环
    event_base_dispatch(base);

        // 释放内存
    evconnlistener_free(listener);
    event_free(signal_event);
    event_base_free(base);

    printf("done\n");
    return 0;
}

static void
listener_cb(struct evconnlistener *listener, evutil_socket_t fd,
    struct sockaddr *sa, int socklen, void *user_data)
{
    struct event_base *base = user_data;
    struct bufferevent *bev;

    bev = bufferevent_socket_new(base, fd, BEV_OPT_CLOSE_ON_FREE);
    if (!bev) {
        fprintf(stderr, "Error constructing bufferevent!");
        event_base_loopbreak(base);
        return;
    }
    bufferevent_setcb(bev, NULL, conn_writecb, conn_eventcb, NULL);
    bufferevent_enable(bev, EV_WRITE);
    bufferevent_disable(bev, EV_READ);

    bufferevent_write(bev, MESSAGE, strlen(MESSAGE));
}

static void
conn_writecb(struct bufferevent *bev, void *user_data)
{
    struct evbuffer *output = bufferevent_get_output(bev);
    if (evbuffer_get_length(output) == 0) {
        printf("flushed answer\n");
        bufferevent_free(bev);
    }
}

static void
conn_eventcb(struct bufferevent *bev, short events, void *user_data)
{
    if (events & BEV_EVENT_EOF) {
        printf("Connection closed.\n");
    } else if (events & BEV_EVENT_ERROR) {
        printf("Got an error on the connection: %s\n",
            strerror(errno));/*XXX win32*/
    }
    /* None of the other events can happen here, since we haven't enabled
     * timeouts */
    bufferevent_free(bev);
}

static void
signal_cb(evutil_socket_t sig, short events, void *user_data)
{
    struct event_base *base = user_data;
    struct timeval delay = { 2, 0 };

    printf("Caught an interrupt signal; exiting cleanly in two seconds.\n");

    event_base_loopexit(base, &delay);
}
```
