import { publicConfig } from "@lattice/config";
import { probeEndpoint } from "@lattice/monitor/probe";
import { CopyButton } from "../components";
import { DefinitionRow, Page, PageHeader, Section, Status } from "../ui";
import { formatCheckedAt, statusPresentation } from "./status";

export const dynamic = "force-dynamic";

export default async function NetworkPage() {
  const observations = await Promise.all(publicConfig.rpc.map(async (endpoint) => ({
    endpoint,
    observation: await probeEndpoint(
      endpoint.httpUrl,
      endpoint.websocketUrl,
      endpoint.expectedGenesisHash,
      2_500,
    ),
  })));
  const anyOperational = observations.some(({ observation }) => observation.httpStatus === "operational");

  return (
    <Page toc={[["Network", "#network"], ["RPC endpoints", "#rpc"], ["Probe policy", "#monitoring"], ["Public access", "#public"]]}>
      <PageHeader label="Network" title="Identity and health, checked live">
        <p>Configured RPC endpoints are probed server-side with bounded timeouts. A response is healthy only when identity and freshness checks succeed.</p>
      </PageHeader>

      <Section id="network" label="Development network" title="Independent genesis pending">
        <dl className="facts">
          <DefinitionRow term="Network">{anyOperational ? <Status state="good">Observed</Status> : <Status state="bad">Unavailable — no healthy validator</Status>}</DefinitionRow>
          <DefinitionRow term="Topology">Planned single-validator development node</DefinitionRow>
          <DefinitionRow term="Expected genesis">Not configured</DefinitionRow>
          <DefinitionRow term="Public RPC">Unavailable</DefinitionRow>
          <DefinitionRow term="Availability history">Collecting after first persisted observation</DefinitionRow>
        </dl>
      </Section>

      <Section id="rpc" label="RPC endpoints" title="Configured local access">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Endpoint</th><th>URL</th><th>Status</th><th>Genesis</th><th>Slot</th><th>Latency</th><th>Checked</th></tr></thead>
            <tbody>
              {observations.map(({ endpoint, observation }) => {
                const presentation = statusPresentation(observation.httpStatus);
                return (
                  <tr key={endpoint.label}>
                    <td><strong>{endpoint.label}</strong><small>{endpoint.environment}</small></td>
                    <td><span className="table-copy"><code>{endpoint.httpUrl}</code><CopyButton value={endpoint.httpUrl} /></span></td>
                    <td><Status state={presentation.tone}>{presentation.label}</Status><small>{observation.httpReason}</small></td>
                    <td>{observation.genesisHash ?? "Unavailable"}<small>{observation.genesisMatches === null ? "Expected identity not set" : observation.genesisMatches ? "Matches" : "Mismatch"}</small></td>
                    <td>{observation.slot ?? "Unavailable"}</td>
                    <td>{observation.latencyMs === null ? "Unavailable" : `${observation.latencyMs} ms`}</td>
                    <td>{formatCheckedAt(observation.checkedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {observations.map(({ endpoint, observation }) => (
          <div className="wss-row" key={`${endpoint.label}-wss`}>
            <span>WebSocket · {endpoint.label}</span>
            <code>{endpoint.websocketUrl ?? "Not configured"}</code>
            <Status state={observation.websocketStatus === "operational" ? "good" : observation.websocketStatus === "unavailable" ? "bad" : "neutral"}>{observation.websocketStatus}</Status>
            <small>{observation.websocketReason}</small>
          </div>
        ))}
      </Section>

      <Section id="monitoring" label="Monitoring" title="What the probe establishes">
        <ul className="check-list">
          <li>Parsed JSON-RPC response, not HTTP 200 alone.</li>
          <li><code>getGenesisHash</code> checked against configured identity when available.</li>
          <li>Health, finalized progress, version, and latest blockhash checked independently.</li>
          <li>WebSocket reported separately and requires a real subscription message.</li>
        </ul>
        <p className="caption">Page probe timeout: 2.5 seconds. Worker defaults: every 15 seconds, 5-second timeout, stale after 60 seconds.</p>
      </Section>

      <Section id="public" label="Public access" title="No public endpoint deployed">
        <p>A public RPC requires a real host, TLS, persistent node infrastructure, method controls, body limits, abuse controls, and WebSocket limits. No fictional domain is shown.</p>
      </Section>
    </Page>
  );
}
