# PDF sang Word (chạy hoàn toàn trên trình duyệt)

Ứng dụng web tĩnh chuyển một tệp PDF (công văn, văn bản hành chính; cả PDF có chữ lẫn bản quét) sang Word (.docx) chỉnh sửa được.
Mọi xử lý (đọc PDF, nhận dạng chữ OCR, dựng bố cục, tạo .docx) chạy **trong trình duyệt của người dùng**. Không có máy chủ xử lý, không có API ngoài.

## Quyền riêng tư: nói đúng những gì được đảm bảo

- Tệp PDF và tệp Word **không được tải lên đâu cả**. Sau khi trang khởi động xong, ứng dụng không gửi request nào nữa (có test kiểm tra).
- Không ghi nội dung tài liệu vào localStorage, IndexedDB, Cache Storage, service worker hay console.
- Trang web vẫn được tải từ máy chủ lưu trữ (Vercel): bên lưu trữ thấy lượt truy cập trang, địa chỉ IP và thông tin trình duyệt, **nhưng không thấy tệp của bạn**.
- Ngoài phạm vi đảm bảo: tiện ích trình duyệt, mã bị can thiệp sau khi triển khai, bộ nhớ/swap của hệ điều hành, quy định nội bộ của cơ quan về dùng phần mềm lưu trữ trên mạng.
- Nút "Chọn tệp khác" chỉ xóa dữ liệu đang giữ trong trình duyệt. Tệp Word bạn đã tải về vẫn còn trên máy.
- Không dùng tài liệu thật, tài liệu mật để thử trên bản chưa được kiểm tra; không đính kèm chúng vào công cụ AI đám mây hay commit vào git.

## Giới hạn

- Tối đa **10 MiB** và **20 trang** mỗi tệp. Tệp có mật khẩu chưa được hỗ trợ.
- Chất lượng Word: chữ, đoạn, căn lề, đậm, bảng kẻ và con dấu được giữ; **ngắt dòng và ngắt trang có thể khác bản gốc** vì Word dùng phông Times New Roman. OCR không nhận chữ nghiêng và có thể đọc sai; luôn đối chiếu với bản gốc. Chi tiết: [docs/quality-evaluation.md](docs/quality-evaluation.md).
- Trình duyệt hỗ trợ: Chrome và Edge bản mới trên máy tính (cần Web Worker, WebAssembly, OffscreenCanvas). Đã kiểm thử tự động trên Chromium; Edge và Chrome thật cần kiểm tra tay trước khi nghiệm thu.
- Lần mở trang đầu tải thêm vài chục MB dữ liệu (bộ đọc PDF và mô hình nhận dạng tiếng Việt/Anh); các lần sau trình duyệt kiểm tra lại bằng ETag.

## Phát triển

Cần Node 22 trở lên.

```bash
npm install
npm run dev            # chạy thử (tự sao chép engine vào public/engine)
npm run typecheck
npm run test           # test đơn vị
npm run build          # bản production vào dist/
npm run test:e2e       # test trình duyệt đầy đủ (Playwright, cần: npx playwright install chromium)
npm run test:deploy    # kiểm tra header/CSP/khởi động engine trên bản production
npm run benchmark      # đo chất lượng trên tài liệu mẫu tự tạo
npm run fixtures:generate   # tạo lại tài liệu mẫu vào .test-artifacts/fixtures
```

Tài liệu mẫu đều là dữ liệu giả, tạo bằng `npm run fixtures:generate`; chúng nằm trong `.test-artifacts/` và không được commit.

## Triển khai lên Vercel

Đây là web tĩnh: không có API route, function, cơ sở dữ liệu hay khóa bí mật. Cấu hình nằm trong [vercel.json](vercel.json) (framework Vite, lệnh build `npm run build`, thư mục `dist`, CSP chặt, header bảo mật).

**Cách 1: Vercel CLI (không cần GitHub)**

```bash
npm install --global vercel      # hoặc dùng: npx vercel
vercel login
vercel                           # tạo bản PREVIEW; trả về một địa chỉ https://....vercel.app
```

**Cách 2: qua GitHub**: đẩy mã lên một repo (private), vào vercel.com → Add New → Project → Import repo. Giữ nguyên các mặc định (framework Vite, build `npm run build`, output `dist`). Mỗi nhánh/PR sinh một bản preview.

Lưu ý:
- Bản preview mặc định bật **Deployment Protection** (phải đăng nhập Vercel mới xem được). Đừng tắt nó chỉ để chạy test; dùng bypass secret bên dưới.
- Lệnh build tự chạy `npm run assets:copy` để chép engine PDF.js và Tesseract (mô hình vie, eng) vào `dist/engine/`. Mọi tệp đều phục vụ từ chính domain, không dùng CDN.

### Kiểm tra bản preview bằng dữ liệu giả

1. Trong Vercel: Project → Settings → Deployment Protection → **Protection Bypass for Automation** → tạo secret.
2. Chạy (tài liệu mẫu nằm trên máy bạn, được nạp vào ô chọn tệp của trình duyệt):

```bash
BASE_URL=https://<ten-preview>.vercel.app \
VERCEL_AUTOMATION_BYPASS_SECRET=<secret> \
npm run test:e2e -- tests/e2e/deployment.spec.ts
```

Bộ test này kiểm tra header/CSP, loại tệp và cache của tệp engine, không có script/phông/biểu mẫu ngoài, không có telemetry, khởi động engine, chuyển đổi PDF có chữ và bản quét khi chặn mạng, và không lưu gì vào trình duyệt.

Nếu không chạy được bước trên, hãy mở địa chỉ preview, mở DevTools → Network, chọn một tệp mẫu giả và xác nhận: sau khi trang tải xong, không có request nào mới khi chuyển đổi; Console không có lỗi "Content Security Policy".
