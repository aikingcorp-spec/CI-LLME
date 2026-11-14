/**
 * VNBot help nav and the markdown index the bot fetches.
 * Chapter files live in docs/vnbot. This file does not import site identity from the marketing site.
 * The index URL matches packages/adapters/src/platform-identity.ts.
 */

export const VNBOT_CANONICAL_ORIGIN = "https://vnbot.run";
export const VNBOT_OFFICIAL_APP = "https://app.vnbot.run";
export const VNBOT_HELP_INDEX_URL = "https://vnbot.run/help.md";
export const VNBOT_HELP_PATH = "/help/";

export const VNBOT_AGENT_INDEX = [
  "# VNBot",
  "",
  `Website chính thức: ${VNBOT_CANONICAL_ORIGIN}/.`,
  `Cổng web: ${VNBOT_OFFICIAL_APP}.`,
  "",
  `- [VNBot (Tiếng Việt)](${VNBOT_CANONICAL_ORIGIN}/)`,
  `- [VNBot (English)](${VNBOT_CANONICAL_ORIGIN}/en/)`,
  `- [Hướng dẫn VNBot](${VNBOT_CANONICAL_ORIGIN}${VNBOT_HELP_PATH})`,
  `- [Mục lục hướng dẫn dạng Markdown](${VNBOT_HELP_INDEX_URL})`,
  "",
].join("\n");

export type VnbotHelpPage = {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
};

export type VnbotHelpSection = {
  readonly title: string;
  readonly pages: readonly VnbotHelpPage[];
};

export const VNBOT_HELP_SECTIONS = [
  {
    title: "Người đang dùng",
    pages: [
      {
        slug: "vnbot-la-gi",
        title: "VNBot là gì",
        summary: "Website chính thức, cổng web, và dữ liệu nằm trên máy nào.",
      },
      {
        slug: "bat-dau",
        title: "Bắt đầu trong cuộc chat",
        summary: "Chọn bot, nhắn tin, dừng và duyệt khi bạn đã ở trong ứng dụng.",
      },
      {
        slug: "mo-hinh",
        title: "Nối mô hình",
        summary: "Nối mô hình trong Cài đặt trước khi nhờ bot dùng mô hình đó.",
      },
      {
        slug: "ket-noi-ung-dung",
        title: "Kết nối ứng dụng",
        summary: "Chủ máy lưu khóa một lần. Mỗi người nối tài khoản ứng dụng của mình.",
      },
      {
        slug: "telegram",
        title: "Telegram",
        summary: "Tìm kênh chat và biết khi nào cần người quản trị cấu hình.",
      },
      {
        slug: "may-tinh",
        title: "Máy tính của bot",
        summary: "Máy của bot khác máy của bạn, và cách tiếp quản khi bot cần người.",
      },
      {
        slug: "quy-trinh",
        title: "Đặt việc tự chạy",
        summary: "Lịch và kiểm tra định kỳ, ngắn nhất 5 phút.",
      },
      {
        slug: "giong-noi",
        title: "Giọng nói",
        summary: "Nghe, chép lời, đọc lại và gọi khi máy đang có kết nối đó.",
      },
      {
        slug: "space-moi",
        title: "Không gian và lời mời",
        summary: "Mời người vào đúng Không gian, không bắt họ dựng máy chủ.",
      },
      {
        slug: "ket-noi-tu-xa",
        title: "Kết nối từ xa",
        summary: "Bật đường vào từ nơi khác, và phân biệt ngoại tuyến với chưa bật.",
      },
      {
        slug: "tai-khoan",
        title: "Tài khoản",
        summary: "Đăng xuất, đổi email và chọn ngôn ngữ.",
      },
      {
        slug: "khi-gap-loi",
        title: "Khi gặp lỗi",
        summary: "Đọc đúng phần bị lỗi. Hết giờ không phải đã xong hay đã sai khóa.",
      },
    ],
  },
  {
    title: "Người quản trị máy",
    pages: [
      {
        slug: "quan-tri",
        title: "Dành cho người quản trị",
        summary: "Cài đặt, cập nhật và chỗ dữ liệu trên máy đang chạy VNBot.",
      },
    ],
  },
] as const satisfies readonly VnbotHelpSection[];

export const VNBOT_HELP_PAGES: readonly VnbotHelpPage[] = VNBOT_HELP_SECTIONS.flatMap<VnbotHelpPage>(
  (section) => section.pages,
);

export function vnbotHelpPath(slug?: string): string {
  return slug ? `/help/${slug}/` : VNBOT_HELP_PATH;
}

export function vnbotHelpMarkdownPath(slug?: string): string {
  return slug ? `/help/${slug}.md` : "/help.md";
}

export function vnbotHelpCanonical(slug?: string): string {
  return `${VNBOT_CANONICAL_ORIGIN}${vnbotHelpPath(slug)}`;
}

export function vnbotHelpChapterUrl(slug: string): string {
  return `${VNBOT_CANONICAL_ORIGIN}${vnbotHelpMarkdownPath(slug)}`;
}

const HELP_CHAPTER_LINK = /https:\/\/vnbot\.run\/help\/([a-z0-9-]+)\.md/g;

/** HTML pages link inside this site. The markdown the bot fetches keeps the canonical URL. */
export function vnbotHelpHtmlMarkdown(markdown: string): string {
  return markdown.replace(HELP_CHAPTER_LINK, "/help/$1/");
}

export function vnbotHelpIndexMarkdown(): string {
  const lines = [
    "# Hướng dẫn VNBot",
    "",
    "Chọn chủ đề bạn cần để bắt đầu hoặc tìm cách xử lý một vấn đề.",
    "",
    `Mục lục chính thức là ${vnbotHelpCanonical()}.`,
    "",
  ];
  for (const section of VNBOT_HELP_SECTIONS) {
    lines.push(`## ${section.title}`, "");
    for (const page of section.pages) {
      lines.push(`- [${page.title}](${vnbotHelpChapterUrl(page.slug)}). ${page.summary}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function vnbotMarkdownResponse(body: string, method = "GET"): Response {
  return new Response(method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Language": "vi",
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept, Accept-Encoding",
    },
  });
}
