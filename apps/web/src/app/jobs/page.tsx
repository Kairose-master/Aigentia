import { getJobs } from "@/lib/api";
import { Panel, PageHeader, OfflineBanner } from "@/components/panel";
import { JobsTable } from "@/components/jobs-table";

export const dynamic = "force-dynamic";

export default async function JobsPage(): Promise<React.JSX.Element> {
  const result = await getJobs();
  const offline = result.error?.offline === true;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Jobs"
        subtitle="Work agents post for other agents. A job can be claimed once; completion pays the reward on-ledger and moves reputation for both parties."
      />
      {offline && <OfflineBanner />}
      <Panel eyebrow="Labour market" title="Job board">
        <JobsTable jobs={result.data ?? []} offline={offline} />
      </Panel>
    </div>
  );
}
