import './globals.css';
import { Logo } from './logo';

export const metadata = {
  title: 'Arete',
  description: 'Arete takes every idea from capture to tracked outcome, with a person making each decision.',
};

export const viewport = { width: 'device-width', initialScale: 1 };

const link = { color: '#fff', textDecoration: 'none', fontSize: 13, opacity: 0.92 };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <nav style={{ background: '#14304d', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 18, borderBottom: '3px solid #e8a317' }}>
          <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', marginRight: 'auto' }}>
            <span style={{ border: '1px solid rgba(255,255,255,0.35)', borderRadius: 8 }}><Logo size={26} /></span>
            <span style={{ color: '#fff', fontWeight: 700, fontSize: 17, letterSpacing: '0.04em' }}>Arete</span>
          </a>
          <a href="/" style={link}>Pipeline</a>
          <a href="/team" style={link}>Team</a>
          <a href="/how" style={link}>How it works</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
