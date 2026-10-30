import type { APIRoute } from "astro";

const LLMS_TXT = `# VNBot

> Đội nhân viên AI của riêng bạn. Mỗi bot có trí nhớ, máy tính riêng và tự làm việc theo lịch. Dùng mô hình AI bạn đã có. Dữ liệu là của bạn.

- [VNBot (Tiếng Việt)](https://vnbot.run/)
- [VNBot (English)](https://vnbot.run/en/)
`;

export const GET: APIRoute = ({ request }) =>
  new Response(request.method === "HEAD" ? null : LLMS_TXT, {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
