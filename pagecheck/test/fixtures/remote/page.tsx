"use client";
// planted: a script from another host
export default function Page() {
  return <div><script src="https://x.example/a.js" async /><p>remote</p></div>;
}
