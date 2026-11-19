/**
 * Danh sách mật khẩu phổ biến (đã ≥ 10 ký tự, vì chính sách yêu cầu tối thiểu 10) để từ chối khi đăng ký/đổi mật khẩu.
 * So khớp không phân biệt hoa/thường. Danh sách ngắn gọn nhưng bao phủ các mẫu hay gặp nhất;
 * có thể mở rộng bằng tệp lớn hơn mà không đổi giao diện.
 */
const COMMON = [
  '1234567890', '0123456789', '12345678910', '123456789012', '1234512345', '1111111111', '0000000000', '9876543210',
  '1q2w3e4r5t', '1qaz2wsx3e', '1q2w3e4r5t6y', 'qwertyuiop', 'qwertyuiop1', 'asdfghjkl1', 'asdfghjklq', 'zxcvbnm123',
  'qwerty1234', 'qwerty12345', 'qwertyuiop123', 'qazwsxedc1', 'qazwsxedcrfv', 'q1w2e3r4t5', 'a1b2c3d4e5', 'abcdefghij',
  'abcd123456', 'abc1234567', 'abcdef1234', 'password12', 'password123', 'password1234', 'password12345', 'password1!',
  'passw0rd123', 'p@ssw0rd123', 'p@ssword123', 'pa$$word123', 'password!1', 'letmein1234', 'letmein123', 'welcome123',
  'welcome1234', 'welcome12345', 'iloveyou12', 'iloveyou123', 'iloveyou1234', 'monkey1234', 'dragon1234', 'sunshine12',
  'sunshine123', 'princess12', 'princess123', 'football12', 'football123', 'baseball12', 'superman12', 'superman123',
  'trustno1234', 'admin12345', 'admin123456', 'administrator', 'administrator1', 'changeme123', 'changeme12', 'default1234',
  'test123456', 'test1234567', 'testtest12', 'user123456', 'login12345', 'master1234', 'shadow1234', 'michael123',
  'matkhau123', 'matkhau1234', 'matkhau12345', 'matkhaucuatoi', 'xinchao123', 'xinchao1234', 'vietnam123', 'vietnam1234',
  'hanoi12345', 'saigon1234', 'saigon12345', 'toiyeuban123', 'anhyeuem123', 'emyeuanh123', '0123456789a', '1234567890a',
  'a123456789', 'a1234567890', 'aa123456789', 'abc123456789', '123456789a', '123456789q', '123123123123', '123321123321',
  '147258369', '1472583690', '147258369a', '159753456852', 'iloveyou123456', 'qweasdzxc123', '123qweasdzxc', 'zaq12wsxcde3',
];

const SET = new Set(COMMON.map((p) => p.toLowerCase()));

export function isCommonPassword(password: string): boolean {
  return SET.has(password.toLowerCase());
}
