import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

// Chuỗi tiếng Việt phải nằm tập trung trong src/lib/i18n/ (Constitution VI).
// Phát hiện bằng ký tự có dấu đặc trưng của tiếng Việt trong literal của thành phần giao diện.
const VIETNAMESE_LITERAL = '[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]';

const config = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'next-env.d.ts', 'src/lib/db/migrations/**'],
  },
  {
    files: ['src/components/**/*.{ts,tsx}', 'src/app/**/*.tsx'],
    ignores: ['src/components/ui/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=/${VIETNAMESE_LITERAL}/]`,
          message: 'Không viết chuỗi tiếng Việt cứng trong thành phần giao diện; đặt trong src/lib/i18n/vi.ts.',
        },
        {
          selector: `JSXText[value=/${VIETNAMESE_LITERAL}/]`,
          message: 'Không viết chuỗi tiếng Việt cứng trong thành phần giao diện; đặt trong src/lib/i18n/vi.ts.',
        },
      ],
    },
  },
];

export default config;
