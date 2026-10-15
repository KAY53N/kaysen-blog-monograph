/**
 * The site's categories. Every post belongs to exactly one of these, so keep the
 * list short — they are the header navigation. Rename or replace entries here,
 * then update the `category` value in each post's frontmatter to match; the
 * build fails on any mismatch.
 *
 * Order matters: it is the order used in the header.
 */
export const categories = [
  "Engineering",
  "Reliability",
  "Cloud",
  "Security",
  "Web3",
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

export const categoryLabels: Record<Category, string> = {
  Engineering: "后端",
  Reliability: "运维",
  Cloud: "云",
  Security: "安全",
  Web3: "Web3",
  AI: "人工智能",
  "Design Systems": "设计系统",
};

export const categoryLabel = (category: string) =>
  (categoryLabels as Record<string, string>)[category] ?? category;

/** One line per category, shown on its archive page and in listings. */
export const categoryDescriptions: Record<Category, string> = {
  Engineering: "契约、工具，以及把软件真正交付出去的日常手艺。",
  Reliability: "故障、可观测性，以及让系统保持诚实的习惯。",
  Cloud: "基础设施、成本，以及不挡路的部署流水线。",
  Security: "面向产品团队的认证、隐私与威胁相关工作。",
  Web3: "链上合约、交易所与代币相关的部署和实验。",
  AI: "评测、模型行为，以及能在生产环境站住脚的自动化。",
  "Design Systems": "Token、组件，以及让界面保持一致的系统设计。",
};
