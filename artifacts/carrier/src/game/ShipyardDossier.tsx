/**
 * ShipyardDossier — abilities, stats, and system reference for the active slot.
 */
import type { ReactNode } from "react";
import {
  FACTIONS,
  MOTHER_SHIP,
  PLATFORM,
  PLATFORM_DEFS,
  PLATFORM_KINDS,
  FACTION_BUILD,
  factionFleetShip,
  fleetRoleDefFor,
  miningFor,
  mothershipEntryFor,
  platformDefFor,
  statCardForFactionMothership,
  type FactionId,
  type PlatformKind,
} from "@workspace/carrier-net";
import {
  BUILD_SYSTEM_FACTS,
  ROCK_SYSTEM_FACTS,
  type ShipyardDossierRef,
  type ShipyardSlot,
} from "./shipyardCatalog";
import {
  MOTHERSHIPS,
  STAT_META,
  TURRET_ROLE_COLOR,
  type ShipStats,
} from "./motherships";

function StatBars({ stats }: { stats: ShipStats }) {
  return (
    <div className="flex flex-col gap-2">
      {STAT_META.map((s) => (
        <div key={s.label} className="flex items-center gap-2">
          <span className="w-14 text-[10px] uppercase tracking-wider text-white/50">{s.label}</span>
          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${stats[s.key]}%`, background: s.color }}
            />
          </div>
          <span className="w-5 text-right text-[10px] tabular-nums text-white/40">{stats[s.key]}</span>
        </div>
      ))}
    </div>
  );
}

function FactList({ facts }: { facts: readonly { label: string; value: string }[] }) {
  return (
    <dl className="flex flex-col gap-1.5">
      {facts.map((f) => (
        <div key={f.label} className="flex justify-between gap-3 text-[11px]">
          <dt className="text-white/45">{f.label}</dt>
          <dd className="text-right text-white/75">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.28em] text-white/40">{title}</h3>
      {children}
    </div>
  );
}

export function ShipyardDossier({
  slot,
  faction,
}: {
  slot: ShipyardSlot;
  faction: FactionId;
}) {
  const factionDef = FACTIONS[faction];
  const d: ShipyardDossierRef = slot.dossier;

  if (d.type === "mothership") {
    const cap = mothershipEntryFor(faction, d.shipType);
    const base = MOTHERSHIPS[d.shipType] ?? MOTHERSHIPS[0];
    return (
      <div className="flex flex-col gap-4 text-sm">
        <div>
          <div className="text-lg font-bold uppercase tracking-wide" style={{ color: factionDef.color }}>{cap.codename}</div>
          <div className="text-xs italic text-white/45">{cap.tagline}</div>
        </div>
        <p className="text-[12px] leading-relaxed text-white/65">{cap.description}</p>
        <Section title="Special">
          <p className="text-[12px] text-white/70">{cap.special}</p>
        </Section>
        <Section title="Combat Stats">
          <StatBars stats={statCardForFactionMothership(faction, d.shipType)} />
        </Section>
        <Section title="Perks">
          <ul className="flex flex-col gap-1 text-[12px] text-white/70">
            {cap.perks.map((p) => (
              <li key={p}><span className="text-[#5dff9b]">+ </span>{p}</li>
            ))}
          </ul>
        </Section>
        <Section title="Turret Loadout">
          <div className="flex flex-col gap-1.5">
            {base.turrets.map((t) => (
              <div key={t.label} className="flex items-center justify-between rounded border border-white/10 bg-black/25 px-2 py-1.5 text-[11px]">
                <span>{t.label}</span>
                <span style={{ color: TURRET_ROLE_COLOR[t.role] }}>{t.role}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
    );
  }

  if (d.type === "fleet") {
    const authored = factionFleetShip(faction, d.role);
    const roleDef = fleetRoleDefFor(faction, d.role);
    const card = authored?.stats ?? null;
    return (
      <div className="flex flex-col gap-4 text-sm">
        <div>
          <div className="text-base font-bold" style={{ color: factionDef.color }}>{authored?.codename ?? roleDef?.label ?? d.role}</div>
          <div className="text-[11px] text-white/45">Deployed fleet · {factionDef.name}</div>
        </div>
        {authored?.special && (
          <Section title="Special">
            <p className="text-[12px] text-white/70">{authored.special}</p>
          </Section>
        )}
        {roleDef && (
          <Section title="Deploy">
            <FactList facts={[
              { label: "Cost", value: `${roleDef.cost} cr` },
              { label: "Cap", value: String(roleDef.cap) },
              { label: "Hull scale", value: `${roleDef.scale} m` },
              { label: "HP / Shield", value: `${roleDef.maxHp} / ${roleDef.maxShield}` },
              { label: "Operation zone", value: `${roleDef.zoneR} m` },
              { label: "Armed", value: roleDef.armed ? "Yes" : "No (harvester)" },
            ]} />
          </Section>
        )}
        {card && (
          <Section title="Combat Stats">
            <StatBars stats={card} />
          </Section>
        )}
      </div>
    );
  }

  if (d.type === "station") {
    return (
      <div className="flex flex-col gap-4 text-sm">
        <div>
          <div className="text-base font-bold" style={{ color: factionDef.color }}>{factionDef.name} Station</div>
          <div className="text-[11px] text-white/45">In-match mothership hull</div>
        </div>
        <p className="text-[12px] leading-relaxed text-white/65">{factionDef.blurb}</p>
        <Section title="Capital">
          <FactList facts={[
            { label: "Faction", value: factionDef.name },
            { label: "Fit length", value: `${Math.round(slot.fit)} m` },
            { label: "Parts", value: String(slot.catalogIds.length) },
            { label: "Turret salvo", value: `${MOTHER_SHIP.turretSalvoBolts} bolts` },
          ]} />
        </Section>
      </div>
    );
  }

  if (d.type === "platform-kind" || d.type === "build-system" || d.type === "platform-asset") {
    const kinds = d.type === "platform-kind" ? [d.kind] : PLATFORM_KINDS;
    return (
      <div className="flex flex-col gap-4 text-sm">
        <div>
          <div className="text-base font-bold text-[#00d4ff]">Build System</div>
          <div className="text-[11px] text-white/45">Tethered platforms · all factions</div>
        </div>
        <Section title="Rules">
          <FactList facts={BUILD_SYSTEM_FACTS} />
        </Section>
        <Section title="Platform Types">
          <div className="flex flex-col gap-2">
            {kinds.map((kind: PlatformKind) => {
              const def = platformDefFor(faction, kind);
              const build = FACTION_BUILD[faction];
              return (
                <div key={kind} className="rounded border border-white/10 bg-black/25 px-2.5 py-2 text-[11px]">
                  <div className="font-semibold text-white/85">{def.label} · {def.cost} cr</div>
                  <div className="mt-0.5 text-white/50">{def.blurb}</div>
                  {kind === "production" && (
                    <div className="mt-1 text-white/40">+{build.productionBonusPerSec} cr/s each</div>
                  )}
                  {kind === "utility" && (
                    <div className="mt-1 text-white/40">{build.utilityRepairPerSec} hp/s · {PLATFORM.utilityRange} m</div>
                  )}
                  {kind === "turret" && (
                    <div className="mt-1 text-white/40">{PLATFORM.turretRange} m range</div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      </div>
    );
  }

  if (d.type === "turret") {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <div className="text-base font-bold text-white/85">{d.variant === "gun" ? "Pulse Turret" : "Heavy Cannon"}</div>
        <p className="text-[12px] text-white/60">
          Mount on mothership classes in the hangar showcase and on capital hulls in matches.
          Import replaces the default GLB fleet-wide (keyed by asset id).
        </p>
      </div>
    );
  }

  if (d.type === "rock" || d.type === "rock-system" || d.type === "rock-claim") {
    return (
      <div className="flex flex-col gap-4 text-sm">
        <div>
          <div className="text-base font-bold text-[#8a7f72]">Rock System</div>
          <div className="text-[11px] text-white/45">{factionDef.name} · harvest & contest</div>
        </div>
        <Section title={`${factionDef.name} Mining`}>
          <FactList facts={[
            { label: "Harvest rate", value: `${miningFor(faction).creditPerSec} cr/s` },
            { label: "Harvest range", value: `${miningFor(faction).range} m` },
            { label: "Profile", value: miningFor(faction).blurb },
          ]} />
        </Section>
        <Section title="Live Arena">
          <FactList facts={ROCK_SYSTEM_FACTS} />
        </Section>
        {d.type === "rock-claim" && (
          <Section title="Rock Claim (planned)">
            <p className="text-[12px] leading-relaxed text-white/60">
              When you claim an outpost, your faction drops a controllable structure on the rock.
              No default model yet — import a GLB above to preview your faction&apos;s claim building.
            </p>
          </Section>
        )}
        <Section title="Outpost Rewards">
          <FactList facts={[
            { label: "Skirmish", value: "2 pirates · 90 cr" },
            { label: "Raid Camp", value: "4 pirates · 180 cr" },
            { label: "Stronghold", value: "6 pirates · 320 cr" },
          ]} />
        </Section>
      </div>
    );
  }

  if (d.type === "spawn") {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <div className="text-base font-bold text-white/85">{slot.label}</div>
        <p className="text-[12px] text-white/60">
          Cosmetic fighter shell — not a deploy class. All six fleet roles remain available
          regardless of which spawn model you import.
        </p>
      </div>
    );
  }

  return null;
}