import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

// Figures are the substance of every screen here — prices, balances, caps, ledger numbers — and
// they are all set in the mono face. A grotesque with a proper tabular set beats the platform
// default, which on Windows is Consolas and on Linux is whatever happens to be installed.
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Conduit',
  description: 'A programmable TRY ⇄ Stellar rail: money follows a rule you signed once.',
  keywords: ['Soroswap', 'Stellar', 'DeFi', 'Trading', 'Freighter'],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      {/* The background belongs to the document, not to a wrapper: every page used to paint its
          own full-height gradient over a grey one set here, so the grey was dead weight and the
          pages each carried a copy of the same decision. */}
      <body className={inter.className}>{children}</body>
    </html>
  );
}
