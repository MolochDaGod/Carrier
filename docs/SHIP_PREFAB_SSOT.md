# Carrier ship prefab SSOT

**Singular pattern** — do not invent parallel loaders or per-screen GLB tables.

## Resolve path

```
faction + role / shipType
  → fleetModelFor(faction, role)          // deployable fleet
  → FIGHTER_GLB.player|enemy              // personal shell
  → FACTION_STATIONS[faction]             // capital station parts
  → mothershipEntryFor + fleet hull id    // hangar capital class

  → hullFactory.loadHullModel / loadStationModel
       cloneShipGraph · tintMetalHull · fitObject · yaw tune
  → optional shipModelStore override (IndexedDB, per asset id)
```

## Who must use it

| Surface | Module |
|---------|--------|
| Live match | `CarrierGame` via `hullFactory` |
| Hangar / captain pick | `MothershipSelect` / `MothershipShowcase` |
| Fleet deploy roster | `FleetRosterPanel` / `factionShips` |
| Shipyard import | `shipyardCatalog.buildShipyardSlots` → all 6 roles + 6 capitals + station |
| Become / captain | same entity `shipType` 0..5 as `DEPLOY_ROLES` |

## Six fleet roles (all ships)

`miner · scout · corsair · frigate · cruiser · dreadnought`  
Indexed 0..5 = mothership class + deployable hull.

## Aegis forcefield

- Radius: `motherAegisRadius()` = 320 m × 5 = **1600 m**
- Friendly zone: `maxShield × 3`, fast full regen after **10 s** quiet over **5 s**
- Net: `MOTHER_AEGIS` in `@workspace/carrier-net`

## Fire laser + destroy FX

- Primary: faster `WEAPON` (90 ms) + fireCast / fireSparks VFX
- Destroy / big explode: explosion + fireArea + fireball + fireSparks + shockwave
