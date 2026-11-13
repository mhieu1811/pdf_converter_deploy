# Đánh giá chất lượng chuyển PDF → Word (Task 5)

Trạng thái cổng duyệt: **`pending-user-review`**. Máy đã đo xong. Phần còn thiếu duy nhất là bạn mở file Word và kiểm tra bằng mắt.

Toàn bộ xử lý chạy trong trình duyệt. Không tải tài liệu lên máy chủ và không gọi API bên ngoài.

## 1. Kết quả đo tự động

Đo bằng `npm run benchmark`: 23 tài liệu mẫu tự tạo (không có tài liệu thật), engine đã khởi tạo, mạng bị chặn.

| Nhóm | CER trên mỗi trang | Mục tiêu |
| --- | --- | --- |
| Văn bản native (4 tài liệu, perf 10 trang, 20 trang) | 0,00% | ≤ 0,5% |
| scan-congvan | 0,11% | ≤ 2% |
| scan-table | 1,08% | ≤ 2% |
| scan-skewed-noisy | 0,42% | ≤ 2% |
| scan-rotated | 0,45% | ≤ 2% |
| scan-figure | 0,15% | ≤ 2% |
| Tài liệu hỏng, có mật khẩu, quá 10 MiB, quá 20 trang, scan không đọc được | bị từ chối đúng mã lỗi | từ chối đúng mã |

- **Trường quan trọng** (số công văn, ngày tháng, số tiền như `1.254,7`): đều đúng nguyên văn.
- **Cấu trúc:** bảng kẻ được giữ thành bảng Word thật (không ô trống), con dấu giữ thành ảnh, không trang nào bị biến thành ảnh phẳng.
- **Hiệu năng:** 10 trang native xử lý trong chưa đầy 0,1 giây (mục tiêu ≤ 30 giây). 5 trang scan mất khoảng 5–6 giây (mục tiêu ≤ 180 giây).
- **Phản hồi giao diện:** khởi tạo lần đầu khoảng 0,3 giây. Giao diện bị đứng tối đa khoảng 50–80 ms khi OCR. Hủy khi đang OCR được xác nhận trong dưới 1 giây.
- **Quyền riêng tư:** không có request nào sau khi khởi tạo, không ghi gì vào localStorage, IndexedDB, Cache hay service worker, và nội dung tài liệu không xuất hiện trong console. Đã thử phá để kiểm chứng: bật `cacheMethod: "write"` thì test lưu trữ báo lỗi.
- **Máy đo:** Chromium 158, Apple M5, 10 nhân, 32 GB RAM, macOS. Máy yếu hơn (8 GB RAM) chưa được đo.

## 2. Quá trình cải thiện (trước → sau)

Lần đo đầu (baseline) có 2 lỗi:
- scan-table: sai trường quan trọng `1.254,7` (mất dấu phẩy), CER 1,39%.
- scan-skewed-noisy: mất dòng ngày "ngày 12 tháng 11 năm 2026".

Đã làm:
1. **Đọc lại lần hai** các từ có độ tin cậy thấp, các con số và các vùng bị loại nhầm là nhiễu. Dùng tham số Tesseract riêng cho từng lần gọi (nếu đổi tham số chung thì kết quả các trang sau bị lệch). Chỉ chấp nhận kết quả mới khi không làm mất chữ hoặc dấu. Ngoại lệ: khôi phục dấu `.` `,` trong số khi các chữ số vẫn y nguyên.
2. **Làm mượt phát hiện chữ đậm**: một từ "đậm" nằm giữa hai từ thường coi là đọc nhầm nét chữ.
3. **Sửa bố cục chân văn bản** (Nơi nhận / chữ ký): mỗi cột giữ đúng vị trí và căn lề, có ô đệm ở giữa, bảng thụt vào đúng lề trái.

Đã thử nhưng bỏ: render OCR ở 300 DPI. Kết quả tệ hơn (file scan mẫu chỉ 192 DPI) nên giữ 200 DPI.

Kết quả sau: cả hai lỗi trên đều hết (scan-table 1,08%, các trường quan trọng đúng).

## 3. Giới hạn đã biết

- Chưa kiểm tra bằng Word thật. Mình chỉ xem sơ bằng Quick Look của macOS.
- OCR không nhận chữ nghiêng.
- Dòng tiêu đề to hơn chữ thường dưới 35% sẽ bị đưa về cỡ chữ thường.
- Chữ "3" đứng một mình đôi khi bị nhận là in đậm.
- OCR vẫn có thể đọc sai chữ, ví dụ "Đơn vị tính" thành "Ponvitinh" ở một số lần chạy.
- Trang scan chất lượng rất thấp (độ tin cậy trung bình dưới 70) bị từ chối thay vì chuyển.
- Ô gộp hoặc đường kẻ không đều chỉ được tái tạo gần đúng, kèm cảnh báo.
- Phông chữ gốc được thay bằng Times New Roman nên ngắt dòng, ngắt trang trong Word có thể lệch.
- Trang lớn hơn 22 inch bị thu nhỏ để Word mở được.
- Tài liệu mẫu đều là tự tạo. Cần thử thêm với công văn thật (trên máy bạn, không tải lên đâu).

## 4. Checklist cho bạn kiểm tra trong Word

Mở các file trong `.test-artifacts/outputs/*.docx` (17 file) bằng Word desktop. Với mỗi file kiểm tra:

- [ ] Mở được, không báo lỗi hay "file bị hỏng".
- [ ] Sửa được chữ trong đoạn văn và trong ô bảng (không phải ảnh).
- [ ] Quốc hiệu, tiêu ngữ, tên cơ quan căn đúng và đúng chỗ.
- [ ] Tiêu đề, căn lề (giữa/phải/đều hai bên), thụt đầu dòng, đậm/nghiêng giống bản gốc.
- [ ] Phần "Nơi nhận" nằm bên trái, chữ ký nằm bên phải, thẳng hàng.
- [ ] Con dấu, chữ ký hiện đúng chỗ, không đè lên chữ.
- [ ] Bảng đủ hàng, cột, ô; số liệu đúng (ví dụ `1.254,7`).
- [ ] Thứ tự đọc đúng, không thiếu hoặc lặp chữ, không có chữ chồng nhau.
- [ ] Số trang và chỗ ngắt trang hợp lý.
- [ ] Dấu tiếng Việt đúng (hỏi, ngã, ă, ơ, ư...).

Ghi kết quả vào `.test-artifacts/benchmark/word-inspection.json`:

```json
{ "native-congvan-1p": "pass", "scan-table-1p": "fail" }
```

Giá trị là `"pass"` hoặc `"fail"`; fixture nào chưa ghi thì vẫn là "chờ duyệt". Sau đó chạy `npm run benchmark` để xem cổng duyệt cập nhật.
