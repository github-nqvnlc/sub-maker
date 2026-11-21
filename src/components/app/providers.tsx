'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { I18nProvider } from '@/lib/i18n/client';
import type { Locale } from '@/lib/i18n/locale';
import type { Dict } from '@/lib/i18n/types';

export function Providers({ children, locale, dict }: { children: React.ReactNode; locale: Locale; dict: Dict }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  return (
    // Theme Sáng/Tối/Theo hệ thống (spec 003): next-themes đặt lớp `dark` bằng script trước khi vẽ nên không nhấp nháy sai theme
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="theme" disableTransitionOnChange>
      <I18nProvider locale={locale} dict={dict}>
        <QueryClientProvider client={client}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster richColors position="bottom-right" />
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
