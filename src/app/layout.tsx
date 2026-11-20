import type { Metadata } from 'next';
import { Be_Vietnam_Pro } from 'next/font/google';
import './globals.css';
import { getDict } from '@/lib/i18n';
import { getLocale, getT } from '@/lib/i18n/server';
import { cn } from '@/lib/utils';
import { Providers } from '@/components/app/providers';

// Font có ĐỦ bộ ký tự tiếng Việt (Outfit chỉ có latin/latin-ext nên chữ có dấu chồng bị lệch sang font dự phòng).
// next/font lưu font cùng ứng dụng khi build, không gọi Google lúc chạy; `display: 'swap'` hiện chữ bằng font dự phòng trong lúc tải.
const beVietnam = Be_Vietnam_Pro({
  subsets: ['latin', 'latin-ext', 'vietnamese'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-be-vietnam',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t.app.name, description: t.app.description };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Ngôn ngữ theo cookie `locale` (mặc định tiếng Việt): `lang` và từ điển của client đều lấy từ đây (spec 003, FR-020/FR-021)
  const locale = await getLocale();
  return (
    <html lang={locale} suppressHydrationWarning className={cn('font-sans', beVietnam.variable)}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers locale={locale} dict={getDict(locale)}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
