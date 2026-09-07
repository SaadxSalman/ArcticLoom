import './globals.css';
import { Inter } from 'next/font/google';

const inter = Inter({ subsets: ['latin'] });

export const metadata = {
  title: 'ArcticLoom - Local RAG Intelligence',
  description: 'Advanced local document search and Q&A powered by AI',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className} suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}