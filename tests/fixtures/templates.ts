// Authored, synthetic correspondence. Reference text is derived from these structures,
// never from converter output. All names, numbers and places are fictional.

export type Line = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right" | "justify";
  indent?: boolean;
};

export type DocBlock =
  | { kind: "columns"; left: Line[]; right: Line[]; artwork?: boolean; leftWidthPct?: number }
  | { kind: "paragraphs"; lines: Line[] }
  | { kind: "table"; header: string[]; rows: string[][]; widthsPct: number[] };

export type TemplatePage = { blocks: DocBlock[]; criticalFields: string[] };

const SENDER_HEADER: DocBlock = {
  kind: "columns",
  left: [
    { text: "ỦY BAN NHÂN DÂN THÀNH PHỐ MẪU", align: "center" },
    { text: "SỞ KẾ HOẠCH MẪU", bold: true, align: "center" },
  ],
  right: [
    { text: "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM", bold: true, align: "center" },
    { text: "Độc lập - Tự do - Hạnh phúc", bold: true, align: "center" },
  ],
};

const metaBlock = (number: string, subject: string | null, date: string): DocBlock => ({
  kind: "columns",
  left: [{ text: number, align: "left" }, ...(subject ? [{ text: subject, align: "left" as const }] : [])],
  right: [{ text: date, italic: true, align: "center" }],
});

const SIGNATURE: Line[] = [
  { text: "GIÁM ĐỐC", bold: true, align: "center" },
  { text: "(Đã ký)", italic: true, align: "center" },
  { text: "Nguyễn Văn Mẫu", bold: true, align: "center" },
];

export const congvan: TemplatePage[] = [
  {
    blocks: [
      SENDER_HEADER,
      metaBlock(
        "Số: 125/SKH-VP",
        "V/v báo cáo tình hình thực hiện kế hoạch năm 2026",
        "Thành phố Mẫu, ngày 12 tháng 11 năm 2026",
      ),
      {
        kind: "paragraphs",
        lines: [
          { text: "Kính gửi: Các sở, ban, ngành và Ủy ban nhân dân các quận, huyện", align: "center", bold: true },
          {
            text: "Thực hiện chỉ đạo của Ủy ban nhân dân thành phố tại Công văn số 87/UBND-TH ngày 05 tháng 11 năm 2026 về việc tổng hợp tình hình thực hiện kế hoạch phát triển kinh tế - xã hội năm 2026, Sở Kế hoạch Mẫu đề nghị các đơn vị thực hiện các nội dung sau:",
            align: "justify",
            indent: true,
          },
          {
            text: "1. Báo cáo kết quả thực hiện các chỉ tiêu chủ yếu trong chín tháng đầu năm, đánh giá những thuận lợi, khó khăn, vướng mắc và nguyên nhân.",
            align: "justify",
            indent: true,
          },
          {
            text: "2. Đề xuất giải pháp, kiến nghị nhằm hoàn thành kế hoạch năm 2026; gửi báo cáo bằng văn bản và thư điện tử về Sở Kế hoạch Mẫu trước ngày 25 tháng 11 năm 2026.",
            align: "justify",
            indent: true,
          },
          { text: "Rất mong nhận được sự phối hợp của Quý cơ quan./.", align: "justify", indent: true },
        ],
      },
      {
        kind: "columns",
        left: [
          { text: "Nơi nhận:", bold: true, italic: true },
          { text: "- Như trên;" },
          { text: "- Lưu: VT, VP." },
        ],
        right: SIGNATURE,
        artwork: true,
        leftWidthPct: 50,
      },
    ],
    criticalFields: [
      "Số: 125/SKH-VP",
      "ngày 12 tháng 11 năm 2026",
      "Kính gửi: Các sở, ban, ngành và Ủy ban nhân dân các quận, huyện",
      "ngày 25 tháng 11 năm 2026",
    ],
  },
];

export const tableLetter: TemplatePage[] = [
  {
    blocks: [
      SENDER_HEADER,
      metaBlock("Số: 131/SKH-TH", null, "Thành phố Mẫu, ngày 14 tháng 11 năm 2026"),
      {
        kind: "paragraphs",
        lines: [
          { text: "BÁO CÁO TỔNG HỢP MỘT SỐ CHỈ TIÊU CHÍN THÁNG ĐẦU NĂM 2026", bold: true, align: "center" },
          { text: "Kính gửi: Ủy ban nhân dân thành phố Mẫu", align: "center" },
          { text: "Sở Kế hoạch Mẫu tổng hợp kết quả thực hiện các chỉ tiêu chủ yếu như sau:", align: "justify", indent: true },
        ],
      },
      {
        kind: "table",
        header: ["STT", "Chỉ tiêu", "Đơn vị tính", "Kết quả 9 tháng"],
        rows: [
          ["1", "Tổng thu ngân sách", "Tỷ đồng", "1.254,7"],
          ["2", "Vốn đầu tư công đã giải ngân", "Tỷ đồng", "843,2"],
          ["3", "Doanh nghiệp thành lập mới", "Doanh nghiệp", "1.087"],
        ],
        widthsPct: [10, 46, 20, 24],
      },
      {
        kind: "paragraphs",
        lines: [
          { text: "Sở Kế hoạch Mẫu kính báo cáo Ủy ban nhân dân thành phố xem xét, chỉ đạo./.", align: "justify", indent: true },
        ],
      },
      { kind: "columns", left: [{ text: "Nơi nhận:", bold: true, italic: true }, { text: "- Như trên;" }, { text: "- Lưu: VT, TH." }], right: SIGNATURE },
    ],
    criticalFields: ["Số: 131/SKH-TH", "ngày 14 tháng 11 năm 2026", "Kính gửi: Ủy ban nhân dân thành phố Mẫu", "1.254,7", "843,2", "1.087"],
  },
];

export const listPlan: TemplatePage[] = [
  {
    blocks: [
      SENDER_HEADER,
      metaBlock("Số: 98/SKH-TH", null, "Thành phố Mẫu, ngày 08 tháng 11 năm 2026"),
      {
        kind: "paragraphs",
        lines: [
          { text: "KẾ HOẠCH TRIỂN KHAI NHIỆM VỤ QUÝ IV NĂM 2026", bold: true, align: "center" },
          { text: "(Ban hành kèm theo Quyết định số 311/QĐ-SKH ngày 08 tháng 11 năm 2026)", italic: true, align: "center" },
          { text: "I. MỤC ĐÍCH, YÊU CẦU", bold: true },
          {
            text: "1. Mục đích: Tổ chức triển khai đồng bộ các nhiệm vụ trọng tâm của quý IV, bảo đảm hoàn thành các chỉ tiêu kế hoạch phát triển kinh tế - xã hội đã được Hội đồng nhân dân thành phố thông qua.",
            align: "justify",
          },
          {
            text: "2. Yêu cầu: Xác định rõ người chịu trách nhiệm, thời hạn hoàn thành và sản phẩm đầu ra của từng nhiệm vụ; không để xảy ra tình trạng chậm tiến độ hoặc trùng lặp công việc giữa các đơn vị.",
            align: "justify",
          },
          {
            text: "3. Các nhiệm vụ phải được báo cáo định kỳ hằng tuần và được cập nhật đầy đủ trên hệ thống quản lý văn bản điện tử của thành phố.",
            align: "justify",
          },
        ],
      },
    ],
    criticalFields: ["Số: 98/SKH-TH", "ngày 08 tháng 11 năm 2026", "311/QĐ-SKH"],
  },
  {
    blocks: [
      {
        kind: "paragraphs",
        lines: [
          { text: "II. NỘI DUNG THỰC HIỆN", bold: true },
          { text: "- Rà soát, hoàn thiện danh mục các dự án đầu tư công trung hạn giai đoạn 2026 - 2030.", align: "justify" },
          { text: "- Đôn đốc giải ngân vốn đầu tư công, tháo gỡ khó khăn, vướng mắc về giải phóng mặt bằng.", align: "justify" },
          { text: "- Tổ chức hội nghị đối thoại với doanh nghiệp về cải thiện môi trường đầu tư, kinh doanh.", align: "justify" },
          { text: "- Hoàn thiện báo cáo đánh giá tác động của việc chuyển đổi số trong hoạt động quản lý nhà nước.", align: "justify" },
          { text: "- Chuẩn bị các điều kiện tổ chức tổng kết công tác năm 2026 và triển khai nhiệm vụ năm 2027.", align: "justify" },
          { text: "III. PHÂN CÔNG TRÁCH NHIỆM", bold: true },
          { text: "1. Văn phòng Sở chủ trì tổng hợp, theo dõi và đôn đốc việc thực hiện Kế hoạch này.", align: "justify" },
          { text: "2. Phòng Kế hoạch - Tổng hợp chịu trách nhiệm xây dựng báo cáo tiến độ hằng tuần.", align: "justify" },
          { text: "3. Phòng Đầu tư công phối hợp với các chủ đầu tư rà soát tiến độ giải ngân.", align: "justify" },
        ],
      },
    ],
    criticalFields: ["2026 - 2030"],
  },
  {
    blocks: [
      {
        kind: "paragraphs",
        lines: [
          { text: "IV. TỔ CHỨC THỰC HIỆN", bold: true },
          {
            text: "Thủ trưởng các phòng, đơn vị trực thuộc căn cứ chức năng, nhiệm vụ được giao tổ chức thực hiện nghiêm túc Kế hoạch này. Trong quá trình thực hiện, nếu có khó khăn, vướng mắc, kịp thời báo cáo Giám đốc Sở xem xét, quyết định.",
            align: "justify",
            indent: true,
          },
          { text: "Đề nghị các sở, ngành liên quan phối hợp chặt chẽ để bảo đảm hoàn thành các nhiệm vụ đúng tiến độ./.", align: "justify", indent: true },
        ],
      },
      {
        kind: "columns",
        left: [
          { text: "Nơi nhận:", bold: true, italic: true },
          { text: "- Như mục IV;" },
          { text: "- UBND thành phố (để báo cáo);" },
          { text: "- Lưu: VT, VP." },
        ],
        right: SIGNATURE,
      },
    ],
    criticalFields: [],
  },
];

export const diacritics: TemplatePage[] = [
  {
    blocks: [
      {
        kind: "paragraphs",
        lines: [
          { text: "KIỂM TRA HIỂN THỊ DẤU TIẾNG VIỆT", bold: true, align: "center" },
          {
            text: "Hà Nội, Hải Phòng, Huế, Đà Nẵng, Nha Trang, Thành phố Hồ Chí Minh, Cần Thơ và Quảng Ngãi là những địa danh có nhiều dấu thanh khác nhau.",
            align: "justify",
          },
          {
            text: "Quyết định này có hiệu lực kể từ ngày ký; những quy định trước đây trái với Quyết định này đều bị bãi bỏ.",
            italic: true,
            align: "justify",
          },
          { text: "Nguyễn Thị Thuỷ, Trần Văn Quyền, Lê Hoàng Ngọc Ánh, Phạm Đức Thắng, Đỗ Thị Ngân, Vũ Quang Huy.", bold: true, align: "justify" },
          {
            text: "Ưu tiên hoàn thành các ước tính về kết quả thực hiện: mười ba nghìn bảy trăm hai mươi lăm đồng; ngày 31/12/2026; số 4.560/QĐ-UBND.",
            align: "justify",
          },
          { text: "Người ăn quả nhớ kẻ trồng cây, uống nước nhớ nguồn; ở hiền gặp lành, một con ngựa đau cả tàu bỏ cỏ.", align: "justify" },
          { text: "Tiếng Việt giàu thanh điệu: ngang, huyền, sắc, hỏi, ngã, nặng.", align: "center" },
        ],
      },
    ],
    criticalFields: ["Nguyễn Thị Thuỷ", "31/12/2026", "4.560/QĐ-UBND"],
  },
];

// Mixed fixture 1: a native heading above a body that exists only as a scanned image.
export const MIXED_HEADING: Line[] = [
  { text: "CÔNG VĂN HỎA TỐC", bold: true, align: "center" },
  { text: "Số: 77/SKH-VP", align: "left" },
];
export const MIXED_SCANNED_BODY: Line[] = [
  {
    text: "Để kịp thời phục vụ kỳ họp Hội đồng nhân dân thành phố, Sở Kế hoạch Mẫu đề nghị các đơn vị hoàn thành và gửi số liệu đánh giá giữa kỳ trước ngày 20 tháng 11 năm 2026.",
    align: "justify",
    indent: true,
  },
  {
    text: "Các số liệu cần bảo đảm tính chính xác, thống nhất với báo cáo đã gửi Ủy ban nhân dân thành phố; đơn vị nào gửi chậm phải báo cáo giải trình bằng văn bản.",
    align: "justify",
    indent: true,
  },
  { text: "Trân trọng cảm ơn sự hợp tác của Quý cơ quan./.", align: "justify", indent: true },
];
export const MIXED_NATIVE_PAGE2: Line[] = [
  { text: "PHỤ LỤC: DANH SÁCH ĐƠN VỊ NHẬN VĂN BẢN", bold: true, align: "center" },
  { text: "1. Sở Tài chính Mẫu; 2. Sở Xây dựng Mẫu; 3. Sở Giao thông Mẫu; 4. Sở Nội vụ Mẫu.", align: "justify" },
  { text: "5. Ủy ban nhân dân quận Một; 6. Ủy ban nhân dân quận Hai; 7. Ủy ban nhân dân huyện Ba.", align: "justify" },
];

// Mixed fixture 2: a scanned page whose hidden text layer is corrupted (UTF-8 read as Windows-1252).
export const BAD_LAYER_SCANNED: Line[] = [
  { text: "THÔNG BÁO", bold: true, align: "center" },
  { text: "Số: 64/TB-SKH", align: "left" },
  {
    text: "Sở Kế hoạch Mẫu thông báo lịch làm việc tuần từ ngày 16 tháng 11 đến ngày 20 tháng 11 năm 2026 như sau: sáng thứ hai họp giao ban, chiều thứ tư tiếp doanh nghiệp, sáng thứ sáu tổng kết tuần.",
    align: "justify",
    indent: true,
  },
];
export const BAD_LAYER_NATIVE_PAGE2: Line[] = [
  { text: "Trang 2: Ghi chú", bold: true, align: "left" },
  { text: "Lịch làm việc có thể thay đổi theo yêu cầu của lãnh đạo Sở; mọi thay đổi sẽ được thông báo trước một ngày.", align: "justify" },
];

export function referenceOfBlocks(blocks: DocBlock[]): string {
  const lines: string[] = [];
  // Neighbouring column blocks share one Word table, which is read cell by cell: all left lines, then all right lines.
  let columns: Extract<DocBlock, { kind: "columns" }>[] = [];
  const flushColumns = () => {
    lines.push(...columns.flatMap((block) => block.left.map((line) => line.text)), ...columns.flatMap((block) => block.right.map((line) => line.text)));
    columns = [];
  };
  for (const block of blocks) {
    if (block.kind === "columns") {
      columns.push(block);
      continue;
    }
    flushColumns();
    if (block.kind === "paragraphs") {
      lines.push(...block.lines.map((line) => line.text));
    } else {
      lines.push(block.header.join(" "), ...block.rows.map((row) => row.join(" ")));
    }
  }
  flushColumns();
  return lines.join("\n").normalize("NFC");
}

export const referenceOfLines = (lines: Line[]): string =>
  lines.map((line) => line.text).join("\n").normalize("NFC");

export const countTables = (pages: TemplatePage[]): number =>
  pages.reduce((sum, page) => sum + page.blocks.filter((block) => block.kind === "table").length, 0);

export const countArtwork = (pages: TemplatePage[]): number =>
  pages.reduce(
    (sum, page) => sum + page.blocks.filter((block) => block.kind === "columns" && block.artwork).length,
    0,
  );

const FILLER_SENTENCES = [
  "Sở Kế hoạch Mẫu đã tổ chức rà soát danh mục dự án đầu tư công và đề xuất điều chỉnh kế hoạch vốn phù hợp với tiến độ thực tế.",
  "Các đơn vị trực thuộc báo cáo đầy đủ kết quả thực hiện nhiệm vụ được giao và nêu rõ những khó khăn, vướng mắc cần tháo gỡ.",
  "Việc phối hợp giữa các sở, ngành và Ủy ban nhân dân các quận, huyện được tăng cường, bảo đảm thông tin thông suốt.",
  "Công tác cải cách thủ tục hành chính tiếp tục được đẩy mạnh, rút ngắn thời gian giải quyết hồ sơ cho người dân và doanh nghiệp.",
  "Kết quả giải ngân vốn đầu tư công đạt tỷ lệ cao hơn so với cùng kỳ năm trước, góp phần thúc đẩy tăng trưởng kinh tế.",
  "Đề nghị các đơn vị tiếp tục nâng cao trách nhiệm, chủ động xử lý công việc và báo cáo kịp thời theo đúng quy định hiện hành.",
];

/** Deterministic multi-page body used by the performance fixtures. */
export function longDocument(pageCount: number, label: string): TemplatePage[] {
  return Array.from({ length: pageCount }, (_, index) => {
    const lines: Line[] = [{ text: `${label} - Trang ${index + 1}`, bold: true, align: "center" }];
    for (let paragraph = 0; paragraph < 5; paragraph++) {
      const first = FILLER_SENTENCES[(index + paragraph) % FILLER_SENTENCES.length];
      const second = FILLER_SENTENCES[(index + paragraph + 2) % FILLER_SENTENCES.length];
      lines.push({ text: `${paragraph + 1}. ${first} ${second}`, align: "justify" });
    }
    return { blocks: [{ kind: "paragraphs", lines }] as DocBlock[], criticalFields: [] };
  });
}
