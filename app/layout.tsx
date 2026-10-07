import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MuniGPT | Public Records Research",
  description: "Research municipal public records with source citations.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
