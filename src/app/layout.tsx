import type { Metadata } from 'next';
import { Outfit } from 'next/font/google';
import './globals.css';
import { vi } from '@/lib/i18n/vi';
import { cn } from '@/lib/utils';
import { Providers } from '@/components/app/providers';

const outfit = Outfit({ subsets: ['latin', 'latin-ext'], variable: '--font-outfit', display: 'swap' });

export const metadata: Metadata = {
  title: vi.app.name,
  description: vi.app.description,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi" suppressHydrationWarning className={cn('font-sans', outfit.variable)}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
