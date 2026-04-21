// Canonical property → unit-slot configuration.
// Multi-unit listings on Guesty are backed by multiple physical Airbnbs.
// A booking for a 6-BR listing (property 4) must be backed by TWO buy-ins:
// one for unit "721" and one for unit "812".
//
// This file is the single source of truth — both client and server import it.

export type UnitConfig = {
  unitId: string;
  unitLabel: string;
  bedrooms: number;
};

export type PropertyUnitConfig = {
  community: string;
  units: UnitConfig[];
};

// CONDO / TOWNHOME ONLY — do not add villas, detached houses, or single-family
// dwellings. Each property must be an individually-owned unit within a clustered
// condo complex or townhome community. Removed 2026-04: properties 7, 10, 12, 14,
// 21, 26, 28, 31, 36 (all villa or single-family; business model pivot).
export const PROPERTY_UNIT_CONFIGS: Record<number, PropertyUnitConfig> = {
  1:  { community: "Poipu Kai",         units: [{ unitId: "924",   unitLabel: "Unit 924",        bedrooms: 3 }, { unitId: "114",   unitLabel: "Unit 114",        bedrooms: 2 }, { unitId: "911", unitLabel: "Unit 911", bedrooms: 2 }] },
  4:  { community: "Poipu Kai",         units: [{ unitId: "721",   unitLabel: "Unit 721",        bedrooms: 3 }, { unitId: "812",   unitLabel: "Unit 812",        bedrooms: 3 }] },
  8:  { community: "Poipu Kai",         units: [{ unitId: "A",     unitLabel: "Unit A",          bedrooms: 3 }, { unitId: "B",     unitLabel: "Unit B",          bedrooms: 3 }] },
  9:  { community: "Poipu Kai",         units: [{ unitId: "A",     unitLabel: "Unit A",          bedrooms: 3 }, { unitId: "B",     unitLabel: "Unit B",          bedrooms: 2 }] },
  18: { community: "Poipu Kai",         units: [{ unitId: "A",     unitLabel: "Unit A",          bedrooms: 3 }, { unitId: "B",     unitLabel: "Unit B",          bedrooms: 3 }] },
  19: { community: "Princeville",       units: [{ unitId: "A",     unitLabel: "Townhome A",      bedrooms: 3 }, { unitId: "B",     unitLabel: "Townhome B",      bedrooms: 2 }] },
  20: { community: "Princeville",       units: [{ unitId: "A",     unitLabel: "Townhome A",      bedrooms: 3 }, { unitId: "B",     unitLabel: "Townhome B",      bedrooms: 3 }] },
  23: { community: "Kapaa Beachfront",  units: [{ unitId: "A",     unitLabel: "Unit A",          bedrooms: 3 }, { unitId: "B",     unitLabel: "Unit B",          bedrooms: 2 }] },
  24: { community: "Poipu Oceanfront",  units: [{ unitId: "A",     unitLabel: "Unit A",          bedrooms: 3 }, { unitId: "B",     unitLabel: "Unit B",          bedrooms: 2 }] },
  27: { community: "Poipu Kai",         units: [{ unitId: "A",     unitLabel: "Unit A",          bedrooms: 2 }, { unitId: "B",     unitLabel: "Unit B",          bedrooms: 2 }] },
  29: { community: "Princeville",       units: [{ unitId: "A",     unitLabel: "Townhome A",      bedrooms: 3 }, { unitId: "B",     unitLabel: "Townhome B",      bedrooms: 4 }] },
  32: { community: "Pili Mai",          units: [{ unitId: "A",     unitLabel: "Townhome A",      bedrooms: 3 }, { unitId: "B",     unitLabel: "Townhome B",      bedrooms: 2 }] },
  33: { community: "Pili Mai",          units: [{ unitId: "A",     unitLabel: "Townhome A",      bedrooms: 3 }, { unitId: "B",     unitLabel: "Townhome B",      bedrooms: 3 }] },
  34: { community: "Poipu Kai",         units: [{ unitId: "A",     unitLabel: "Unit A",          bedrooms: 3 }, { unitId: "B",     unitLabel: "Unit B",          bedrooms: 3 }] },
  37: { community: "Windsor Hills",     units: [{ unitId: "main",  unitLabel: "Main Condo",      bedrooms: 3 }] },
};

export function getPropertyUnits(propertyId: number): UnitConfig[] {
  return PROPERTY_UNIT_CONFIGS[propertyId]?.units ?? [];
}

export function getUnitConfig(propertyId: number, unitId: string): UnitConfig | undefined {
  return PROPERTY_UNIT_CONFIGS[propertyId]?.units.find((u) => u.unitId === unitId);
}

export function totalBedroomsForProperty(propertyId: number): number {
  return getPropertyUnits(propertyId).reduce((s, u) => s + u.bedrooms, 0);
}
