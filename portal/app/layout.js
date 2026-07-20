import "./globals.css";

export const metadata = {
  title: "AutoTest.ai",
  description:
    "Clone a repo, run Cypress funnel scripts, review screenshots with a VLM (UI/UX, Arabic/RTL, i18n), auto-file bugs.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
