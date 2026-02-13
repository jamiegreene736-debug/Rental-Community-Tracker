export type AmenityCategory = {
  name: string;
  items: string[];
};

export const LODGIFY_AMENITY_CATEGORIES: AmenityCategory[] = [
  {
    name: "General",
    items: [
      "Air conditioning",
      "Ceiling fans",
      "Central heating",
      "Wi-Fi",
      "Internet access",
      "Iron & ironing board",
      "Hair dryer",
      "Smoke detector",
      "Carbon monoxide detector",
      "Fire extinguisher",
      "First aid kit",
      "Keyless entry",
      "Elevator access",
    ],
  },
  {
    name: "Kitchen",
    items: [
      "Full kitchen",
      "Refrigerator",
      "Dishwasher",
      "Microwave",
      "Oven",
      "Stove",
      "Coffee maker",
      "Toaster",
      "Blender",
      "Cookware & utensils",
      "Dishes & silverware",
      "Wine glasses",
      "Spices & cooking basics",
      "Dining table",
    ],
  },
  {
    name: "Living Areas",
    items: [
      "Smart TV",
      "Cable TV",
      "Streaming services",
      "DVD player",
      "Board games",
      "Books & reading material",
      "Sound system",
      "Desk / workspace",
    ],
  },
  {
    name: "Bedrooms & Sleeping",
    items: [
      "King bed",
      "Queen bed",
      "Twin beds",
      "Sofa bed / futon",
      "Bed linens provided",
      "Extra pillows & blankets",
      "Blackout curtains",
      "Alarm clock",
      "Walk-in closet",
    ],
  },
  {
    name: "Bathroom",
    items: [
      "Bathtub",
      "Shower",
      "Walk-in shower",
      "Jetted tub",
      "Dual sinks",
      "Toiletries provided",
      "Bath towels provided",
      "Beach towels provided",
    ],
  },
  {
    name: "Laundry",
    items: [
      "Washer",
      "Dryer",
      "Washer & dryer in unit",
      "Laundry detergent",
    ],
  },
  {
    name: "Outdoor & Recreation",
    items: [
      "Swimming pool",
      "Hot tub / jacuzzi",
      "Tennis court",
      "Pickleball court",
      "BBQ / grill",
      "Lanai / balcony",
      "Covered patio",
      "Garden / yard",
      "Outdoor furniture",
      "Beach chairs",
      "Cooler",
      "Beach gear",
      "Bicycle",
    ],
  },
  {
    name: "Parking",
    items: [
      "Free parking",
      "Covered parking",
      "Garage",
      "Street parking",
      "Driveway",
    ],
  },
  {
    name: "Location & Views",
    items: [
      "Beachfront",
      "Ocean view",
      "Mountain view",
      "Garden view",
      "Pool view",
      "Near beach (walking distance)",
      "Near golf course",
      "Near restaurants",
      "Near shopping",
    ],
  },
  {
    name: "Family Friendly",
    items: [
      "Children welcome",
      "High chair",
      "Crib / pack-n-play",
      "Baby gate",
      "Child-safe",
      "Toys & games",
    ],
  },
  {
    name: "Accessibility",
    items: [
      "Ground floor access",
      "Step-free access",
      "Wide doorways",
      "Wheelchair accessible",
      "Roll-in shower",
    ],
  },
];

export type PropertyAmenityDefaults = {
  propertyId: number;
  defaultChecked: string[];
};

const HAWAII_CONDO_DEFAULTS = [
  "Air conditioning",
  "Ceiling fans",
  "Wi-Fi",
  "Internet access",
  "Smoke detector",
  "Full kitchen",
  "Refrigerator",
  "Dishwasher",
  "Microwave",
  "Oven",
  "Stove",
  "Coffee maker",
  "Toaster",
  "Blender",
  "Cookware & utensils",
  "Dishes & silverware",
  "Wine glasses",
  "Dining table",
  "Smart TV",
  "Streaming services",
  "Bed linens provided",
  "Extra pillows & blankets",
  "Shower",
  "Toiletries provided",
  "Bath towels provided",
  "Beach towels provided",
  "Washer & dryer in unit",
  "Swimming pool",
  "Hot tub / jacuzzi",
  "Lanai / balcony",
  "Beach chairs",
  "Cooler",
  "Beach gear",
  "Free parking",
  "Near beach (walking distance)",
  "Near restaurants",
  "Children welcome",
  "Iron & ironing board",
  "Hair dryer",
];

const REGENCY_DEFAULTS = [
  ...HAWAII_CONDO_DEFAULTS,
  "Tennis court",
  "Pickleball court",
  "Garden view",
  "Garden / yard",
  "Outdoor furniture",
];

const KEKAHA_DEFAULTS = [
  ...HAWAII_CONDO_DEFAULTS.filter(a => a !== "Swimming pool" && a !== "Hot tub / jacuzzi"),
  "Beachfront",
  "Ocean view",
  "Garden / yard",
  "Outdoor furniture",
  "BBQ / grill",
  "Covered patio",
  "Bicycle",
];

const KEAUHOU_DEFAULTS = [
  ...HAWAII_CONDO_DEFAULTS.filter(a => a !== "Hot tub / jacuzzi"),
  "Ocean view",
  "Near golf course",
  "Covered patio",
  "Outdoor furniture",
];

const PRINCEVILLE_DEFAULTS = [
  ...HAWAII_CONDO_DEFAULTS,
  "Mountain view",
  "Garden view",
  "Near golf course",
  "Outdoor furniture",
];

export function getDefaultAmenities(propertyId: number): string[] {
  const regencyIds = [1, 4, 7, 8, 33, 34];
  if (regencyIds.includes(propertyId)) return REGENCY_DEFAULTS;

  const kekaha = [9, 10, 12];
  if (kekaha.includes(propertyId)) return KEKAHA_DEFAULTS;

  const keauhou = [14, 18, 19];
  if (keauhou.includes(propertyId)) return KEAUHOU_DEFAULTS;

  const princeville = [20, 21, 23, 24];
  if (princeville.includes(propertyId)) return PRINCEVILLE_DEFAULTS;

  return HAWAII_CONDO_DEFAULTS;
}
