import type { Metadata } from "next";
import Link from "next/link";
import { roleOf, SITE_URL } from "../security";
import { Shell } from "./_ui/Shell";
import { PageHead, ui } from "./_ui/ui";

export const metadata: Metadata = {
  title: "Not found · DNA",
  description: "This page does not exist.",
};

export default function NotFound() {
  // the play origin has no live feed (layout.tsx PlayRoot), so no Shell there: a plain page back to the main site
  if (roleOf(process.env) === "play") return <main><p>There&apos;s no game at this address. <a href={SITE_URL}>Back to DNA</a></p></main>;
  return (
    <Shell>
      <div className={ui.page}>
        <PageHead hero="live" back={null} sample={false} title="Not found" lede="There's no page at this address." />
        <p className={`${ui.prose} ${ui.muted}`}>
          Watch what the AI is doing <Link className={ui.link} href="/live">live</Link>, check the evidence in
          the <Link className={ui.link} href="/lab">Lab</Link>, or go back to the <Link className={ui.link} href="/">start</Link>.
        </p>
      </div>
    </Shell>
  );
}
