"use client";
// planted: the page module throws as it loads
throw new Error("planted: the module throws");

export default function Page() {
  return <p>never</p>;
}
