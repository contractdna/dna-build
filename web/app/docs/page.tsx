import type { Metadata } from "next";
import { connection } from "next/server";
import { Shell } from "../_ui/Shell";
import { ui } from "../_ui/ui";
import { PAGE } from "./content";
import { Docs } from "./Docs";

export const metadata: Metadata = { title: PAGE.metaTitle, description: PAGE.metaDescription };

export default async function DocsPage() {
  // per request, so a shared ?mode= link server-renders that mode (the client reads it with useSearchParams)
  await connection();
  return (
    <Shell>
      <div className={ui.page}>
        <Docs />
      </div>
    </Shell>
  );
}
