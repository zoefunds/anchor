import { Inter, JetBrains_Mono, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
});

export const metadata = {
  title: "Anchor",
  description: "Adjudication-as-a-Service",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${sourceSerif.variable}`}
    >
      <body className="font-sans">{children}</body>
    </html>
  );
}
