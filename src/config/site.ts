export const siteConfig = {
  /** Wordmark shown in the header and footer. Monograph uses text, never a logo image. */
  name: "kaysen.dev",
  tagline: "一处安静的长文写作空间",
  title: "kaysen.dev — 长文与笔记",
  description: "以阅读为先的个人博客，收录关于构建软件的笔记，配有命令面板搜索和明暗阅读模式。",
  siteUrl: "https://kaysen.dev",
  authorName: "Andrei Alba",
  email: "hello@example.com",
  language: "zh-CN",
  dateLocale: "zh-CN",
  locale: "zh_CN",
  socialImage: "/og-image.png",
  /** Shown in the home sidebar "About" card. */
  about: "kaysen.dev 是一个以阅读为先的站点。关于构建软件的笔记，有值得写下的内容时才会发布。",
  /**
   * Both forms below ship enabled with an empty `action`, which makes them fully
   * interactive demos that submit nowhere: a small script confirms the submit
   * and clears the fields. Paste your provider's endpoint into `action` to send
   * real submissions, or set `enabled: false` to disable the controls outright.
   */
  newsletter: {
    enabled: true,
    action: "",
    method: "post",
    emailFieldName: "email",
    title: "用邮件接收新文章",
    description: "有新文章时发一封邮件。没有垃圾邮件，随时可以退订。",
  },
  contact: {
    enabled: true,
    action: "",
    method: "post",
    responseTime: "通常会在两个工作日内回复。",
  },
};

/** Header navigation. Add or remove entries freely; the header renders them in order. */
export const navigation = [
  { label: "归档", href: "/posts/" },
  { label: "分类", href: "/categories/" },
  { label: "关于", href: "/about/" },
];

/** Secondary navigation rendered in the footer. */
export const footerNavigation = [
  { label: "联系", href: "/contact/" },
  { label: "隐私", href: "/privacy/" },
  { label: "RSS", href: "/rss.xml" },
];
