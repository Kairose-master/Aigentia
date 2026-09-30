import Link from "next/link";
import { Panel, EmptyState } from "@/components/panel";

export default function NotFound(): React.JSX.Element {
  return (
    <Panel>
      <EmptyState title="This route does not exist in the Genesis Sector." />
      <div className="border-t border-line px-4 py-3">
        <Link href="/" className="font-mono text-[11px] tracking-[0.14em] text-live uppercase">
          ← overview
        </Link>
      </div>
    </Panel>
  );
}
