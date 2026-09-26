import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getRun } from "@/lib/store";
import { token } from "@/lib/tokens";
import { Frame, ReadResult, MapResult, PlanResult, BuyResult, Trace, StepCard } from "@/components/App";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

function owned(names: string[]) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "nothing yet";
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const run = await getRun((await params).id);
  if (!run) return { title: "Stockback" };
  const names = run.fills.filter((f) => !f.error).map((f) => token(f.ticker)?.name ?? f.ticker);
  const title = `A ${run.merchant} receipt bought a piece of ${owned(names)}`;
  return {
    title: `${title} · Stockback`,
    description: "Stock-back on Robinhood Chain, reasoned by SERV. Snap a receipt, own what you buy.",
    twitter: { card: "summary_large_image", title },
    openGraph: { title },
  };
}

export default async function RunPage({ params }: Props) {
  const run = await getRun((await params).id);
  if (!run) notFound();
  return (
    <Frame>
      <main className="mx-auto max-w-3xl space-y-4 p-4 sm:p-8">
        <div className="glass rounded-[22px] p-5 sm:p-6">
          <p className="text-xs text-muted">
            {new Date(run.created_at).toUTCString()} · {run.mode === "live" ? "LIVE on Robinhood Chain" : "simulated"}
          </p>
          <h1 className="mt-1 text-[32px] leading-tight font-extrabold tracking-tight">{run.merchant}</h1>
          <div className="mt-5 space-y-3">
            <StepCard n={4} title="Stock bought" serv="AgentKit wallet · Robinhood Chain" state="done">
              <BuyResult run={run} plan={run.plan} />
            </StepCard>
            <StepCard n={1} title="Receipt read" serv="vision · JSON schema · prompt guard" state="done">
              <ReadResult receipt={run.receipt} />
            </StepCard>
            <StepCard n={2} title="Who profits" serv="178-ticker enum · shadow agent" state="done">
              <MapResult mapping={run.mapping} receipt={run.receipt} />
            </StepCard>
            <StepCard n={3} title="Rules applied" serv="Multipath · math in code" state="done">
              <PlanResult plan={run.plan} />
            </StepCard>
            {run.traces?.length ? <Trace traces={run.traces} /> : null}
          </div>
        </div>
        <a href="/" className="block rounded-2xl bg-ink px-4 py-3.5 text-center font-bold text-white">
          Scan your own receipt →
        </a>
      </main>
    </Frame>
  );
}
