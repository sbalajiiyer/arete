import './globals.css';

export const metadata = {
  title: 'Idea Management',
  description: 'Seven agents take every idea from capture to tracked outcome.',
};

export const viewport = { width: 'device-width', initialScale: 1 };

const link = { color: '#fff', textDecoration: 'none', fontSize: 13 };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <nav style={{ background: '#1f4e79', padding: '8px 16px', display: 'flex', gap: 18 }}>
          <a href="/" style={link}>Pipeline</a>
          <a href="/how" style={link}>How it works</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
