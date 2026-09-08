"use client";

import { useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { usePublicCase } from "../../cases/[id]/usePublicCase";
import { CasePanel } from "../../cases/[id]/CasePanel";

// Embeddable, iframe-friendly rendering of a case for a marketplace or
// counterparty site to drop in directly:
//
//   <iframe id="anchor-case" src="https://<host>/public/widget/<caseId>?token=<partyToken>"
//           style="width:100%;border:0" title="Anchor case"></iframe>
//   <script>
//     window.addEventListener("message", (e) => {
//       if (e.data && e.data.source === "anchor-widget" && e.data.type === "resize") {
//         document.getElementById("anchor-case").style.height = e.data.height + "px";
//       }
//     });
//   </script>
//
// No nav/header chrome (this route intentionally skips the wordmark the
// full /public/cases/[id] page shows), and no wallet/private-key/chain
// selector is ever rendered — same CasePanel component as the full
// page, just embed=true. Height is reported to the parent frame via
// postMessage on every render so the host page can size the iframe
// without guessing or hardcoding a height.
export default function PublicCaseWidget() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const token = searchParams.get("token");
  const { kase, error, refresh } = usePublicCase(id, token);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function postHeight() {
      const height = containerRef.current?.offsetHeight ?? document.body.scrollHeight;
      window.parent.postMessage({ source: "anchor-widget", type: "resize", height }, "*");
    }
    postHeight();
    const observer = new ResizeObserver(postHeight);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener("resize", postHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", postHeight);
    };
  }, [kase, error]);

  return (
    <div ref={containerRef} className="px-4 py-6">
      {error && <p className="text-sm text-status-undetermined">{error}</p>}
      {!error && !kase && <p className="font-mono text-sm text-muted dark:text-muted-dark">Loading…</p>}
      {kase && <CasePanel id={id} kase={kase} onRefresh={refresh} embed />}
    </div>
  );
}
