/**
 * The site's categories. Every post belongs to exactly one of these, so keep the
 * list short — six is the practical ceiling before the sidebar stops reading as
 * a menu. Rename or replace entries here, then update the `category` value in
 * each post's frontmatter to match; the build fails on any mismatch.
 *
 * Order matters: it is the order used on the categories index and in the home
 * sidebar.
 */
export const categories = [
  "Engineering",
  "Reliability",
  "Cloud",
  "Security",
  "AI",
  "Design Systems",
] as const;

export type Category = (typeof categories)[number];

export const categorySlug = (category: string) =>
  category
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

/** One line per category, shown on its archive page and in listings. */
export const categoryDescriptions: Record<Category, string> = {
  Engineering: "契约、工具，以及把软件真正交付出去的日常手艺。",
  Reliability: "故障、可观测性，以及让系统保持诚实的习惯。",
  Cloud: "基础设施、成本，以及不挡路的部署流水线。",
  Security: "面向产品团队的认证、隐私与威胁相关工作。",
  AI: "评测、模型行为，以及能在生产环境站住脚的自动化。",
  "Design Systems": "Token、组件，以及让界面保持一致的系统设计。",
};
