export type UnitPhoto = {
  filename: string;
  label: string;
  category: string;
};

export type Unit = {
  id: string;
  unitNumber: string;
  bedrooms: number;
  bathrooms: string;
  sqft: string;
  maxGuests: number;
  shortDescription: string;
  longDescription: string;
  photos: UnitPhoto[];
  photoFolder: string;
};

export type CommunityPhoto = {
  filename: string;
  label: string;
  position: "beginning" | "end";
};

export type PropertyUnitBuilder = {
  propertyId: number;
  propertyName: string;
  complexName: string;
  address: string;
  bookingTitle: string;
  sampleDisclaimer: string;
  combinedDescription: string;
  neighborhood?: string;
  transit?: string;
  // Hawaii Tax Map Key — format: ##-#-#-###-###-#### (12 digits, county-district-section-parcel)
  taxMapKey?: string;
  // TAT (Transient Accommodations Tax) License — format: TA-###-###-####-## (issued by Hawaii Dept. of Taxation)
  tatLicense?: string;
  // GET (General Excise Tax) License — format: GE-###-###-####-## (issued by Hawaii Dept. of Taxation, required for ALL businesses)
  getLicense?: string;
  // Short-Term Rental Permit — format depends on county:
  //   Kauai County (VDA zones, e.g. Poipu, Princeville):  TVR-YYYY-##    e.g. TVR-2022-048
  //   Kauai County (non-VDA/residential, e.g. Kekaha, Kaha Lani, Lae Nani):  TVNC-####    e.g. TVNC-0342
  //   Hawaii County (Big Island, e.g. Keauhou, Kona):  STVR-YYYY-######    e.g. STVR-2019-003461
  //   Maui County:  STRH-########    e.g. STRH-20220042
  //   Honolulu (Oahu):  NUC-##-###-####    e.g. NUC-22-001-0134
  strPermit?: string;
  units: Unit[];
  hasPhotos: boolean;
  communityPhotos: CommunityPhoto[];
  communityPhotoFolder: string;
};

const DEFAULT_DISCLAIMER = "Please note: this listing combines two units within the same community. Both are of equivalent size, finishes, and bedroom count to what’s shown. Guests receive separate keys/access codes at check-in, and both units are located within the same building cluster or community grounds.";

export const LISTING_DISCLOSURE = `Please note: this listing combines two units within the same community. Both are of equivalent size, finishes, and bedroom count to what’s shown. Guests receive separate keys/access codes at check-in, and both units are located within the same building cluster or community grounds.

---`;

const COMMUNITY_REGENCY: CommunityPhoto[] = [
  { filename: "01-community.jpg", label: "Resort Pool", position: "beginning" },
  { filename: "02-community.jpg", label: "Tennis Courts", position: "beginning" },
  { filename: "03-community.jpg", label: "Plantation Building", position: "beginning" },
  { filename: "04-community.jpg", label: "Building Exterior", position: "end" },
  { filename: "05-community.jpg", label: "Lagoon Pool", position: "beginning" },
  { filename: "06-community.jpg", label: "Pool & Spa", position: "end" },
];

const COMMUNITY_KEKAHA: CommunityPhoto[] = [
  { filename: "01-community.jpg", label: "Beach Sunset", position: "beginning" },
  { filename: "02-community.jpg", label: "Beach & Ocean", position: "beginning" },
  { filename: "03-community.jpg", label: "Tropical Garden", position: "beginning" },
  { filename: "04-community.jpg", label: "Ocean Sunset View", position: "end" },
  { filename: "05-community.jpg", label: "Oceanfront View", position: "end" },
  { filename: "06-community.jpg", label: "Estate Grounds", position: "end" },
];

const COMMUNITY_KEAUHOU: CommunityPhoto[] = [
  { filename: "01-community.jpg", label: "Big Island Coastline", position: "beginning" },
  { filename: "02-community.jpg", label: "Estate Grounds", position: "beginning" },
  { filename: "03-community.jpg", label: "Ocean View", position: "end" },
  { filename: "04-community.jpg", label: "Sunset", position: "end" },
  { filename: "05-community.jpg", label: "Outdoor Dining", position: "beginning" },
  { filename: "06-community.jpg", label: "Community Grounds", position: "end" },
];

const COMMUNITY_MAUNA_KAI: CommunityPhoto[] = [
  { filename: "01-community.jpg", label: "Resort Pool", position: "beginning" },
  { filename: "02-community.jpg", label: "Princeville Aerial View", position: "beginning" },
  { filename: "03-community.jpg", label: "Pool & Norfolk Pines", position: "beginning" },
  { filename: "04-community.jpg", label: "Community Pool", position: "end" },
  { filename: "05-community.jpg", label: "Townhome Exterior", position: "end" },
];

const COMMUNITY_KAHA_LANI: CommunityPhoto[] = [
  { filename: "01-community.jpg", label: "Oceanfront Pool", position: "beginning" },
  { filename: "02-community.jpg", label: "Beach Path", position: "beginning" },
  { filename: "03-community.jpg", label: "Tennis Court", position: "beginning" },
  { filename: "04-community.jpg", label: "Coastal Walking Path", position: "end" },
  { filename: "05-community.jpg", label: "Resort Grounds", position: "end" },
  { filename: "06-community.jpg", label: "Community View", position: "end" },
];

const COMMUNITY_LAE_NANI: CommunityPhoto[] = [
  { filename: "01-community.jpg", label: "Resort Pool", position: "beginning" },
  { filename: "02-community.jpg", label: "Beach Cove", position: "beginning" },
  { filename: "03-community.jpg", label: "Garden Courtyard", position: "end" },
  { filename: "04-community.jpg", label: "Ocean View", position: "end" },
  { filename: "05-community.jpg", label: "BBQ Area", position: "beginning" },
  { filename: "06-community.jpg", label: "Community Grounds", position: "end" },
];

const COMMUNITY_POIPU_BEACHSIDE: CommunityPhoto[] = [
  { filename: "01-community.jpg", label: "Brennecke Beach Sunset", position: "beginning" },
  { filename: "02-community.jpg", label: "Brennecke Beach Lava Coast", position: "beginning" },
  { filename: "03-community.jpg", label: "Plantation-Style Building", position: "beginning" },
  { filename: "04-community.jpg", label: "Oceanfront Pool", position: "end" },
  { filename: "05-community.jpg", label: "Cliffside Pool & Surf", position: "end" },
];

const COMMUNITY_KAIULANI: CommunityPhoto[] = [
  { filename: "01-community.jpg", label: "Princeville View", position: "beginning" },
  { filename: "02-community.jpg", label: "Pool Area", position: "beginning" },
  { filename: "03-community.jpg", label: "Garden", position: "end" },
  { filename: "04-community.jpg", label: "Cliff View", position: "end" },
  { filename: "05-community.jpg", label: "Community Grounds", position: "beginning" },
  { filename: "06-community.jpg", label: "Community View", position: "end" },
];

const COMMUNITY_POIPU_OCEANFRONT: CommunityPhoto[] = [
  { filename: "01-community.jpg", label: "Brennecke Beach Surf", position: "beginning" },
  { filename: "02-community.jpg", label: "Beach & Lava Rock Coast", position: "beginning" },
  { filename: "03-community.jpg", label: "Brennecke Aerial View", position: "end" },
  { filename: "04-community.jpg", label: "Cliffside Resort Aerial", position: "end" },
  { filename: "05-community.jpg", label: "Oceanfront Lanai View", position: "beginning" },
];

const COMMUNITY_PILI_MAI: CommunityPhoto[] = [
  { filename: "01-community.jpg", label: "Resort Pool at Sunset", position: "beginning" },
  { filename: "02-community.jpg", label: "Plantation Building", position: "beginning" },
  { filename: "03-community.jpg", label: "Lagoon Pool", position: "beginning" },
  { filename: "04-community.jpg", label: "Pool Cabana", position: "end" },
  { filename: "05-community.jpg", label: "Pool & Clubhouse", position: "end" },
  { filename: "06-community.jpg", label: "Golf Course View", position: "end" },
];

const PHOTOS_924: UnitPhoto[] = [
  { filename: "01-living-room-overview.jpg", label: "Living Room Overview", category: "Living Areas" },
  { filename: "02-living-room-seating.jpg", label: "Living Room Seating Area", category: "Living Areas" },
  { filename: "03-dining-area.jpg", label: "Dining Area", category: "Living Areas" },
  { filename: "04-kitchen-overview.jpg", label: "Kitchen Overview", category: "Kitchen" },
  { filename: "05-great-room.jpg", label: "Great Room", category: "Living Areas" },
  { filename: "06-living-kitchen-view.jpg", label: "Living Room and Kitchen", category: "Living Areas" },
  { filename: "07-lanai-garden-view.jpg", label: "Lanai Garden View", category: "Exterior" },
  { filename: "08-master-bedroom-king.jpg", label: "Master Bedroom - King Bed", category: "Bedrooms" },
  { filename: "09-master-bathroom.jpg", label: "Master Bathroom", category: "Bathrooms" },
  { filename: "10-master-bath-shower.jpg", label: "Master Bathroom Shower", category: "Bathrooms" },
  { filename: "11-guest-bedroom.jpg", label: "Guest Bedroom", category: "Bedrooms" },
  { filename: "12-guest-bedroom-2.jpg", label: "Second Guest Bedroom", category: "Bedrooms" },
  { filename: "13-guest-bathroom.jpg", label: "Guest Bathroom", category: "Bathrooms" },
  { filename: "14-loft-futon.jpg", label: "Loft Area with Futon", category: "Bedrooms" },
  { filename: "15-upstairs-bedroom-queen.jpg", label: "Upstairs Bedroom - Queen Bed", category: "Bedrooms" },
  { filename: "16-upstairs-bedroom-view.jpg", label: "Upstairs Bedroom View", category: "Bedrooms" },
  { filename: "17-upstairs-bathroom.jpg", label: "Upstairs Bathroom", category: "Bathrooms" },
  { filename: "18-upstairs-bath-detail.jpg", label: "Upstairs Bathroom Detail", category: "Bathrooms" },
];

const PHOTOS_114: UnitPhoto[] = [
  { filename: "01-pool-resort.jpg", label: "Resort Pool", category: "Exterior" },
  { filename: "02-welcome-entrance.jpg", label: "Welcome Entrance", category: "Exterior" },
  { filename: "03-living-room-ac.jpg", label: "Living Room with AC", category: "Living Areas" },
  { filename: "04-balcony-view.jpg", label: "Balcony View", category: "Exterior" },
  { filename: "05-second-bedroom-king.jpg", label: "Second Bedroom - King Bed", category: "Bedrooms" },
  { filename: "06-modern-kitchen.jpg", label: "Modern Kitchen", category: "Kitchen" },
  { filename: "07-primary-bedroom-queen.jpg", label: "Primary Bedroom - Queen Bed", category: "Bedrooms" },
  { filename: "08-open-floor-plan.jpg", label: "Open Floor Plan", category: "Living Areas" },
  { filename: "09-modern-living-room.jpg", label: "Modern Living Room", category: "Living Areas" },
  { filename: "10-dining-area.jpg", label: "Dining Area", category: "Living Areas" },
  { filename: "11-family-gathering.jpg", label: "Family Gathering Space", category: "Living Areas" },
  { filename: "12-stainless-kitchen.jpg", label: "Stainless Kitchen", category: "Kitchen" },
  { filename: "13-kitchen-stocked.jpg", label: "Fully Stocked Kitchen", category: "Kitchen" },
  { filename: "14-kitchen-full-view.jpg", label: "Kitchen Full View", category: "Kitchen" },
  { filename: "15-work-area.jpg", label: "Work Area", category: "Living Areas" },
  { filename: "16-bedroom-detail.jpg", label: "Bedroom Detail", category: "Bedrooms" },
  { filename: "17-bathroom-sinks.jpg", label: "Bathroom Dual Sinks", category: "Bathrooms" },
  { filename: "18-renovated-bathroom.jpg", label: "Renovated Bathroom", category: "Bathrooms" },
];

const PHOTOS_911: UnitPhoto[] = [
  { filename: "01-living-room.jpg", label: "Living Room", category: "Living Areas" },
  { filename: "02-resort-pool.jpg", label: "Resort Pool", category: "Exterior" },
  { filename: "03-master-bedroom-king.jpg", label: "Master Bedroom - King Bed", category: "Bedrooms" },
  { filename: "04-dining-kitchen.jpg", label: "Dining and Kitchen", category: "Kitchen" },
  { filename: "05-covered-lanai.jpg", label: "Covered Lanai", category: "Exterior" },
  { filename: "06-living-room-tv.jpg", label: "Living Room with Smart TV", category: "Living Areas" },
  { filename: "07-living-lanai-view.jpg", label: "Living Room and Lanai View", category: "Living Areas" },
  { filename: "08-kitchen-full.jpg", label: "Fully Stocked Kitchen", category: "Kitchen" },
  { filename: "09-kitchen-detail.jpg", label: "Kitchen Detail", category: "Kitchen" },
  { filename: "10-large-dining.jpg", label: "Large Dining Area", category: "Living Areas" },
  { filename: "11-second-bedroom-king.jpg", label: "Second Bedroom - King Bed", category: "Bedrooms" },
  { filename: "12-second-bedroom-view.jpg", label: "Second Bedroom View", category: "Bedrooms" },
  { filename: "13-master-bedroom-tv.jpg", label: "Master Bedroom with TV", category: "Bedrooms" },
  { filename: "14-master-bedroom-side.jpg", label: "Master Bedroom Side View", category: "Bedrooms" },
  { filename: "15-bathroom-tub.jpg", label: "Bathroom with Tub", category: "Bathrooms" },
  { filename: "16-master-bath-shower.jpg", label: "Master Bath Shower", category: "Bathrooms" },
  { filename: "17-second-bathroom.jpg", label: "Second Bathroom", category: "Bathrooms" },
  { filename: "18-tropical-lanai.jpg", label: "Tropical Lanai", category: "Exterior" },
];

const PHOTOS_721: UnitPhoto[] = [
  { filename: "01-living-room.jpg", label: "Living Room", category: "Living Areas" },
  { filename: "02-kitchen-overview.jpg", label: "Kitchen Overview", category: "Kitchen" },
  { filename: "03-kitchen-dining.jpg", label: "Kitchen and Dining", category: "Kitchen" },
  { filename: "04-great-room-view.jpg", label: "Great Room View", category: "Living Areas" },
  { filename: "05-lanai-seating.jpg", label: "Lanai Seating", category: "Exterior" },
  { filename: "06-dining-area.jpg", label: "Dining Area", category: "Living Areas" },
  { filename: "07-master-bedroom.jpg", label: "Master Bedroom", category: "Bedrooms" },
  { filename: "08-master-bath.jpg", label: "Master Bathroom", category: "Bathrooms" },
  { filename: "09-guest-bedroom.jpg", label: "Guest Bedroom", category: "Bedrooms" },
  { filename: "10-guest-bedroom-2.jpg", label: "Second Guest Bedroom", category: "Bedrooms" },
  { filename: "11-guest-bathroom.jpg", label: "Guest Bathroom", category: "Bathrooms" },
  { filename: "12-loft-area.jpg", label: "Loft Area", category: "Bedrooms" },
  { filename: "13-bathroom-detail.jpg", label: "Bathroom Detail", category: "Bathrooms" },
  { filename: "14-bedroom-detail.jpg", label: "Bedroom Detail", category: "Bedrooms" },
  { filename: "15-kitchen-detail.jpg", label: "Kitchen Detail", category: "Kitchen" },
  { filename: "16-balcony-view.jpg", label: "Balcony View", category: "Exterior" },
  { filename: "17-living-room-detail.jpg", label: "Living Room Detail", category: "Living Areas" },
  { filename: "18-exterior-view.jpg", label: "Exterior View", category: "Exterior" },
];

const PHOTOS_423: UnitPhoto[] = [
  { filename: "01-covered-dining-lanai.jpg", label: "Covered Dining Lanai", category: "Living Areas" },
  { filename: "02-living-room-lanai.jpg", label: "Living Room and Lanai", category: "Living Areas" },
  { filename: "03-living-room-great-room.jpg", label: "Living Room Great Room", category: "Living Areas" },
  { filename: "04-dining-living-great-room.jpg", label: "Dining and Living Great Room", category: "Living Areas" },
  { filename: "05-dining-area-entry.jpg", label: "Dining Area and Entry", category: "Living Areas" },
  { filename: "06-kitchen-breakfast-bar.jpg", label: "Kitchen and Breakfast Bar", category: "Kitchen" },
  { filename: "07-fully-equipped-kitchen.jpg", label: "Fully Equipped Kitchen", category: "Kitchen" },
  { filename: "08-kitchen-dining-area.jpg", label: "Kitchen and Dining Area", category: "Kitchen" },
  { filename: "09-master-bedroom-suite-lanai.jpg", label: "Master Bedroom Suite Lanai", category: "Bedrooms" },
  { filename: "10-master-bedroom-suite.jpg", label: "Master Bedroom Suite", category: "Bedrooms" },
  { filename: "11-master-bath.jpg", label: "Master Bath", category: "Bathrooms" },
  { filename: "12-master-bath-shower.jpg", label: "Master Bath and Shower", category: "Bathrooms" },
  { filename: "13-second-guest-bedroom.jpg", label: "Second Guest Bedroom", category: "Bedrooms" },
  { filename: "14-third-bedroom-loft.jpg", label: "Third Bedroom Loft", category: "Bedrooms" },
  { filename: "15-third-bedroom-loft-bath.jpg", label: "Third Bedroom Loft and Bath", category: "Bathrooms" },
  { filename: "16-guest-shared-bath.jpg", label: "Guest Shared Bath", category: "Bathrooms" },
  { filename: "17-guest-half-bath.jpg", label: "Guest Half Bath", category: "Bathrooms" },
];

const PHOTOS_621: UnitPhoto[] = [
  { filename: "01-living-room-seating-lanai.jpg", label: "Living Room Seating and Lanai", category: "Living Areas" },
  { filename: "02-main-seating-lanai.jpg", label: "Main Seating and Lanai", category: "Living Areas" },
  { filename: "03-garden-view-living-room.jpg", label: "Garden View Living Room", category: "Living Areas" },
  { filename: "04-dining-living-great-room.jpg", label: "Dining and Living Great Room", category: "Living Areas" },
  { filename: "05-dining-kitchen-living-room.jpg", label: "Dining Kitchen and Living Room", category: "Living Areas" },
  { filename: "06-kitchen-dining-entry.jpg", label: "Kitchen Dining and Entry", category: "Kitchen" },
  { filename: "07-kitchen-breakfast-bar.jpg", label: "Kitchen and Breakfast Bar", category: "Kitchen" },
  { filename: "08-fully-equipped-kitchen.jpg", label: "Fully Equipped Kitchen", category: "Kitchen" },
  { filename: "09-primary-bedroom-lanai.jpg", label: "Primary Bedroom Lanai", category: "Bedrooms" },
  { filename: "10-primary-bedroom-suite.jpg", label: "Primary Bedroom Suite and Lanai", category: "Bedrooms" },
  { filename: "11-primary-bath.jpg", label: "Primary Bath", category: "Bathrooms" },
  { filename: "12-primary-bath-shower.jpg", label: "Primary Bath and Shower", category: "Bathrooms" },
  { filename: "13-second-guest-bedroom-garden.jpg", label: "Second Guest Bedroom and Garden View", category: "Bedrooms" },
  { filename: "14-second-guest-bedroom.jpg", label: "Second Guest Bedroom", category: "Bedrooms" },
  { filename: "15-second-guest-bath.jpg", label: "Second Guest Bath", category: "Bathrooms" },
  { filename: "16-third-bedroom-loft.jpg", label: "Third Bedroom Loft", category: "Bedrooms" },
  { filename: "17-third-bedroom-loft-bath.jpg", label: "Third Bedroom Loft and Bath", category: "Bathrooms" },
  { filename: "18-third-bedroom-bath.jpg", label: "Third Bedroom Bath", category: "Bathrooms" },
];

const PHOTOS_KEKAHA_MAIN: UnitPhoto[] = [
  { filename: "photo_1.jpg", label: "Beachfront Exterior", category: "Exterior" },
  { filename: "photo_2.jpg", label: "Ocean View from Lanai", category: "Exterior" },
  { filename: "photo_3.jpg", label: "Living Room", category: "Living Areas" },
  { filename: "photo_4.jpg", label: "Great Room Overview", category: "Living Areas" },
  { filename: "photo_5.jpg", label: "Dining Area", category: "Living Areas" },
  { filename: "photo_6.jpg", label: "Granite Kitchen", category: "Kitchen" },
  { filename: "photo_7.jpg", label: "Kitchen and Dining", category: "Kitchen" },
  { filename: "photo_8.jpg", label: "Master Bedroom - King", category: "Bedrooms" },
  { filename: "photo_9.jpg", label: "Second Bedroom - Queens", category: "Bedrooms" },
  { filename: "photo_10.jpg", label: "Third Bedroom - Queen", category: "Bedrooms" },
  { filename: "photo_11.jpg", label: "Master Bathroom", category: "Bathrooms" },
  { filename: "photo_12.jpg", label: "Second Bathroom", category: "Bathrooms" },
  { filename: "photo_13.jpg", label: "Oceanfront Patio", category: "Exterior" },
  { filename: "photo_14.jpg", label: "Beach Access", category: "Exterior" },
  { filename: "photo_15.jpg", label: "Sunroom with Twin Bed", category: "Bedrooms" },
  { filename: "photo_16.jpg", label: "Aerial Property View", category: "Exterior" },
  { filename: "photo_17.jpg", label: "Surf Break View", category: "Exterior" },
  { filename: "photo_18.jpg", label: "Sunset from Lanai", category: "Exterior" },
];

const PHOTOS_KEKAHA_COTTAGE: UnitPhoto[] = [
  { filename: "photo_1.jpg", label: "Cottage Exterior", category: "Exterior" },
  { filename: "photo_2.jpg", label: "Ocean View", category: "Exterior" },
  { filename: "photo_3.jpg", label: "Living Room", category: "Living Areas" },
  { filename: "photo_4.jpg", label: "Living and Dining", category: "Living Areas" },
  { filename: "photo_5.jpg", label: "Kitchen", category: "Kitchen" },
  { filename: "photo_6.jpg", label: "Kitchen Detail", category: "Kitchen" },
  { filename: "photo_7.jpg", label: "Master Bedroom - King", category: "Bedrooms" },
  { filename: "photo_8.jpg", label: "Second Bedroom - King", category: "Bedrooms" },
  { filename: "photo_9.jpg", label: "Master En-Suite Bath", category: "Bathrooms" },
  { filename: "photo_10.jpg", label: "Second En-Suite Bath", category: "Bathrooms" },
  { filename: "photo_11.jpg", label: "Third Bathroom", category: "Bathrooms" },
  { filename: "photo_12.jpg", label: "Sun Room", category: "Living Areas" },
  { filename: "photo_13.jpg", label: "Aerial Cottage View", category: "Exterior" },
  { filename: "photo_14.jpg", label: "Cottage and Beach House", category: "Exterior" },
  { filename: "photo_15.jpg", label: "Oceanfront Lanai", category: "Exterior" },
  { filename: "photo_16.jpg", label: "Beachfront Path", category: "Exterior" },
  { filename: "photo_17.jpg", label: "Sunset View", category: "Exterior" },
  { filename: "photo_18.jpg", label: "Beach Access", category: "Exterior" },
];

const PHOTOS_KEKAHA_OHANA: UnitPhoto[] = [
  { filename: "photo_1.jpg", label: "Retractable Lanai Doors", category: "Living Areas" },
  { filename: "photo_2.jpg", label: "Master Bedroom", category: "Bedrooms" },
  { filename: "photo_3.jpg", label: "Master Bathroom", category: "Bathrooms" },
  { filename: "photo_4.jpg", label: "Guest Bedroom 1", category: "Bedrooms" },
  { filename: "photo_5.jpg", label: "Guest Bedroom 2", category: "Bedrooms" },
  { filename: "photo_6.jpg", label: "Guest Bedroom Detail", category: "Bedrooms" },
  { filename: "photo_7.jpg", label: "Living Area with Bar", category: "Living Areas" },
  { filename: "photo_8.jpg", label: "Lower Lanai", category: "Exterior" },
  { filename: "photo_9.jpg", label: "Upper Lanai Ocean View", category: "Exterior" },
  { filename: "photo_10.jpg", label: "Upper Lanai Seating", category: "Exterior" },
  { filename: "photo_11.jpg", label: "Alaula Estate Grounds", category: "Exterior" },
  { filename: "photo_12.jpg", label: "Aerial Estate View", category: "Exterior" },
  { filename: "photo_13.jpg", label: "Home Exterior", category: "Exterior" },
  { filename: "photo_14.jpg", label: "Entry", category: "Exterior" },
  { filename: "photo_15.jpg", label: "Gourmet Kitchen", category: "Kitchen" },
  { filename: "photo_16.jpg", label: "Kitchen and Living", category: "Living Areas" },
  { filename: "photo_17.jpg", label: "Wet Bar", category: "Kitchen" },
  { filename: "photo_18.jpg", label: "Upstairs Living Area", category: "Living Areas" },
];

const PHOTOS_KEAUHOU: UnitPhoto[] = [
  { filename: "photo_1.jpg", label: "Estate Pool and Ocean View", category: "Exterior" },
  { filename: "photo_2.jpg", label: "Living Room", category: "Living Areas" },
  { filename: "photo_3.jpg", label: "Circular Kitchen", category: "Kitchen" },
  { filename: "photo_4.jpg", label: "Master Suite", category: "Bedrooms" },
  { filename: "photo_5.jpg", label: "Garden and Pool", category: "Exterior" },
];

const PHOTOS_MAUNA_KAI_6A: UnitPhoto[] = [
  { filename: "photo_00.jpg", label: "Tropical Resort Exterior", category: "Exterior" },
  { filename: "photo_01.jpg", label: "Open Living Room", category: "Living Areas" },
  { filename: "photo_02.jpg", label: "Living Area with Garden View", category: "Living Areas" },
  { filename: "photo_03.jpg", label: "Granite Kitchen", category: "Kitchen" },
  { filename: "photo_04.jpg", label: "Fully Equipped Kitchen", category: "Kitchen" },
  { filename: "photo_05.jpg", label: "Dining Area", category: "Living Areas" },
  { filename: "photo_06.jpg", label: "Master King Suite", category: "Bedrooms" },
  { filename: "photo_07.jpg", label: "Master Bedroom Detail", category: "Bedrooms" },
  { filename: "photo_08.jpg", label: "Master En-Suite Bath", category: "Bathrooms" },
  { filename: "photo_09.jpg", label: "Guest Queen Bedroom", category: "Bedrooms" },
  { filename: "photo_10.jpg", label: "Second Guest Bedroom", category: "Bedrooms" },
  { filename: "photo_11.jpg", label: "Guest Bathroom", category: "Bathrooms" },
  { filename: "photo_12.jpg", label: "Covered Lanai", category: "Exterior" },
  { filename: "photo_13.jpg", label: "Lanai Seating Area", category: "Exterior" },
  { filename: "photo_14.jpg", label: "Resort Pool", category: "Amenities" },
  { filename: "photo_15.jpg", label: "Hot Tub and Pool Deck", category: "Amenities" },
  { filename: "photo_16.jpg", label: "Mountain Vista", category: "Views" },
  { filename: "photo_17.jpg", label: "Tropical Garden Path", category: "Views" },
  { filename: "photo_18.jpg", label: "Ocean Glimpse from Lanai", category: "Views" },
  { filename: "photo_19.jpg", label: "Sunset over Hanalei", category: "Views" },
  { filename: "photo_20.jpg", label: "Resort Grounds", category: "Exterior" },
  { filename: "photo_21.jpg", label: "Garden Detail", category: "Exterior" },
  { filename: "photo_22.jpg", label: "Community Area", category: "Amenities" },
  { filename: "photo_23.jpg", label: "Outdoor Space", category: "Exterior" },
  { filename: "photo_24.jpg", label: "Princeville View", category: "Views" },
  { filename: "photo_25.jpg", label: "North Shore Landscape", category: "Views" },
  { filename: "photo_26.jpg", label: "Hanalei Valley", category: "Views" },
  { filename: "photo_27.jpg", label: "Tropical Setting", category: "Exterior" },
  { filename: "photo_28.jpg", label: "Resort Detail", category: "Amenities" },
  { filename: "photo_29.jpg", label: "Coastal Panorama", category: "Views" },
];

const PHOTOS_MAUNA_KAI_T3: UnitPhoto[] = [
  { filename: "photo_00.jpg", label: "Townhome Exterior", category: "Exterior" },
  { filename: "photo_01.jpg", label: "Spacious Living Room", category: "Living Areas" },
  { filename: "photo_02.jpg", label: "Great Room with Vaulted Ceilings", category: "Living Areas" },
  { filename: "photo_03.jpg", label: "Modern Kitchen", category: "Kitchen" },
  { filename: "photo_04.jpg", label: "Kitchen and Breakfast Bar", category: "Kitchen" },
  { filename: "photo_05.jpg", label: "Dining Room", category: "Living Areas" },
  { filename: "photo_06.jpg", label: "King Master Bedroom", category: "Bedrooms" },
  { filename: "photo_07.jpg", label: "Master Suite Sitting Area", category: "Bedrooms" },
  { filename: "photo_08.jpg", label: "Master Bathroom with Tub", category: "Bathrooms" },
  { filename: "photo_09.jpg", label: "Queen Guest Room", category: "Bedrooms" },
  { filename: "photo_10.jpg", label: "Third Bedroom with Twins", category: "Bedrooms" },
  { filename: "photo_11.jpg", label: "Hall Bathroom", category: "Bathrooms" },
  { filename: "photo_12.jpg", label: "Private Deck", category: "Exterior" },
  { filename: "photo_13.jpg", label: "Outdoor Dining on Lanai", category: "Exterior" },
  { filename: "photo_14.jpg", label: "Community Pool", category: "Amenities" },
  { filename: "photo_15.jpg", label: "Pool Area Lounge", category: "Amenities" },
  { filename: "photo_16.jpg", label: "North Shore Mountain View", category: "Views" },
  { filename: "photo_17.jpg", label: "Garden and Grounds", category: "Views" },
  { filename: "photo_18.jpg", label: "Tropical Landscaping", category: "Views" },
  { filename: "photo_19.jpg", label: "Princeville Panorama", category: "Views" },
];

const PHOTOS_KAHA_LANI_109: UnitPhoto[] = [
  { filename: "photo_00.jpg", label: "Oceanfront Building Exterior", category: "Exterior" },
  { filename: "photo_01.jpg", label: "Living Room with Ocean View", category: "Living Areas" },
  { filename: "photo_02.jpg", label: "Comfortable Sitting Area", category: "Living Areas" },
  { filename: "photo_03.jpg", label: "Open Kitchen", category: "Kitchen" },
  { filename: "photo_04.jpg", label: "Kitchen with Granite Counters", category: "Kitchen" },
  { filename: "photo_05.jpg", label: "Dining Space", category: "Living Areas" },
  { filename: "photo_06.jpg", label: "Master King Bedroom", category: "Bedrooms" },
  { filename: "photo_07.jpg", label: "Master Suite Ocean View", category: "Bedrooms" },
  { filename: "photo_08.jpg", label: "Master Bath with Shower", category: "Bathrooms" },
  { filename: "photo_09.jpg", label: "Queen Guest Bedroom", category: "Bedrooms" },
  { filename: "photo_10.jpg", label: "Twin Guest Bedroom", category: "Bedrooms" },
  { filename: "photo_11.jpg", label: "Guest Bathroom", category: "Bathrooms" },
  { filename: "photo_12.jpg", label: "Ocean View Lanai", category: "Exterior" },
  { filename: "photo_13.jpg", label: "Lanai Dining Area", category: "Exterior" },
  { filename: "photo_14.jpg", label: "Resort Swimming Pool", category: "Amenities" },
  { filename: "photo_15.jpg", label: "Pool and BBQ Area", category: "Amenities" },
  { filename: "photo_16.jpg", label: "Lydgate Beach View", category: "Views" },
  { filename: "photo_17.jpg", label: "Oceanfront Sunrise", category: "Views" },
  { filename: "photo_18.jpg", label: "Coastal Walking Path", category: "Views" },
  { filename: "photo_19.jpg", label: "Tropical Resort Grounds", category: "Views" },
  { filename: "photo_20.jpg", label: "Resort Entrance", category: "Exterior" },
  { filename: "photo_21.jpg", label: "Garden Walkway", category: "Exterior" },
  { filename: "photo_22.jpg", label: "Community Amenities", category: "Amenities" },
  { filename: "photo_23.jpg", label: "Ocean Coastline", category: "Views" },
  { filename: "photo_24.jpg", label: "Wailua Bay View", category: "Views" },
];

const PHOTOS_KAHA_LANI_123: UnitPhoto[] = [
  { filename: "photo_00.jpg", label: "Resort Entrance", category: "Exterior" },
  { filename: "photo_01.jpg", label: "Bright Living Room", category: "Living Areas" },
  { filename: "photo_02.jpg", label: "Living Area Seating", category: "Living Areas" },
  { filename: "photo_03.jpg", label: "Updated Kitchen", category: "Kitchen" },
  { filename: "photo_04.jpg", label: "Kitchen with Modern Appliances", category: "Kitchen" },
  { filename: "photo_05.jpg", label: "Dining Nook", category: "Living Areas" },
  { filename: "photo_06.jpg", label: "King Master Suite", category: "Bedrooms" },
  { filename: "photo_07.jpg", label: "Master Bedroom with Lanai Access", category: "Bedrooms" },
  { filename: "photo_08.jpg", label: "Master Bathroom", category: "Bathrooms" },
  { filename: "photo_09.jpg", label: "Guest Queen Room", category: "Bedrooms" },
  { filename: "photo_10.jpg", label: "Second Guest Room", category: "Bedrooms" },
  { filename: "photo_11.jpg", label: "Second Bathroom", category: "Bathrooms" },
  { filename: "photo_12.jpg", label: "Private Lanai", category: "Exterior" },
  { filename: "photo_13.jpg", label: "Garden View from Lanai", category: "Exterior" },
  { filename: "photo_14.jpg", label: "Community Pool", category: "Amenities" },
  { filename: "photo_15.jpg", label: "Pool Deck and Lounge Chairs", category: "Amenities" },
  { filename: "photo_16.jpg", label: "Ocean View from Property", category: "Views" },
  { filename: "photo_17.jpg", label: "Beach Access Path", category: "Views" },
  { filename: "photo_18.jpg", label: "Lydgate Park Shoreline", category: "Views" },
  { filename: "photo_19.jpg", label: "Coastal Views", category: "Views" },
  { filename: "photo_20.jpg", label: "Wailua Coast", category: "Views" },
];

const PHOTOS_LAE_NANI: UnitPhoto[] = [
  { filename: "photo_00.jpg", label: "Oceanfront Resort Building", category: "Exterior" },
  { filename: "photo_01.jpg", label: "Living Room with Ocean View", category: "Living Areas" },
  { filename: "photo_02.jpg", label: "Great Room Overview", category: "Living Areas" },
  { filename: "photo_03.jpg", label: "Fully Stocked Kitchen", category: "Kitchen" },
  { filename: "photo_04.jpg", label: "Kitchen and Dining", category: "Kitchen" },
  { filename: "photo_05.jpg", label: "Dining Area with Views", category: "Living Areas" },
  { filename: "photo_06.jpg", label: "King Master Suite", category: "Bedrooms" },
  { filename: "photo_07.jpg", label: "Master Bedroom Detail", category: "Bedrooms" },
  { filename: "photo_08.jpg", label: "Master Bath", category: "Bathrooms" },
  { filename: "photo_09.jpg", label: "Guest Bedroom", category: "Bedrooms" },
  { filename: "photo_10.jpg", label: "Private Beach Cove", category: "Views" },
];

const PHOTOS_POIPU_BEACHSIDE: UnitPhoto[] = [
  { filename: "photo_00.jpg", label: "Beachside Home Exterior", category: "Exterior" },
  { filename: "photo_01.jpg", label: "Open Living Room", category: "Living Areas" },
  { filename: "photo_02.jpg", label: "Comfortable Seating Area", category: "Living Areas" },
  { filename: "photo_03.jpg", label: "Island-Style Kitchen", category: "Kitchen" },
  { filename: "photo_04.jpg", label: "Kitchen with Full Amenities", category: "Kitchen" },
  { filename: "photo_05.jpg", label: "Dining Room", category: "Living Areas" },
  { filename: "photo_06.jpg", label: "King Master Bedroom", category: "Bedrooms" },
  { filename: "photo_07.jpg", label: "Master Suite Detail", category: "Bedrooms" },
  { filename: "photo_08.jpg", label: "Master En-Suite Bathroom", category: "Bathrooms" },
  { filename: "photo_09.jpg", label: "Queen Guest Room", category: "Bedrooms" },
  { filename: "photo_10.jpg", label: "Twin Guest Bedroom", category: "Bedrooms" },
  { filename: "photo_11.jpg", label: "Hall Bathroom", category: "Bathrooms" },
  { filename: "photo_12.jpg", label: "Covered Lanai with Ocean View", category: "Exterior" },
  { filename: "photo_13.jpg", label: "Outdoor Dining and BBQ", category: "Exterior" },
  { filename: "photo_14.jpg", label: "Tropical Garden Setting", category: "Views" },
  { filename: "photo_15.jpg", label: "Beach Access Steps Away", category: "Views" },
];

const PHOTOS_POIPU_OCEANFRONT: UnitPhoto[] = [
  { filename: "photo_00.jpg", label: "Oceanfront Estate Exterior", category: "Exterior" },
  { filename: "photo_01.jpg", label: "Elegant Living Room", category: "Living Areas" },
  { filename: "photo_02.jpg", label: "Living Area with Ocean View", category: "Living Areas" },
  { filename: "photo_03.jpg", label: "Gourmet Kitchen", category: "Kitchen" },
  { filename: "photo_04.jpg", label: "Kitchen Island and Prep Area", category: "Kitchen" },
  { filename: "photo_05.jpg", label: "Formal Dining Area", category: "Living Areas" },
  { filename: "photo_06.jpg", label: "Oceanfront Master Suite", category: "Bedrooms" },
  { filename: "photo_07.jpg", label: "Master Bedroom Retreat", category: "Bedrooms" },
  { filename: "photo_08.jpg", label: "Spa-Style Master Bath", category: "Bathrooms" },
  { filename: "photo_09.jpg", label: "Queen Guest Bedroom", category: "Bedrooms" },
  { filename: "photo_10.jpg", label: "Twin Guest Room", category: "Bedrooms" },
  { filename: "photo_11.jpg", label: "Guest Bathroom", category: "Bathrooms" },
  { filename: "photo_12.jpg", label: "Private Pool and Deck", category: "Amenities" },
  { filename: "photo_13.jpg", label: "Pool with Ocean Backdrop", category: "Amenities" },
  { filename: "photo_14.jpg", label: "Oceanfront Sunset View", category: "Views" },
  { filename: "photo_15.jpg", label: "Coastline from Property", category: "Views" },
];

const PHOTOS_KAIULANI: UnitPhoto[] = [
  { filename: "photo_00.jpg", label: "Townhome Exterior and Entry", category: "Exterior" },
  { filename: "photo_01.jpg", label: "Vaulted Living Room", category: "Living Areas" },
  { filename: "photo_02.jpg", label: "Living Area with Mountain Views", category: "Living Areas" },
  { filename: "photo_03.jpg", label: "Updated Kitchen", category: "Kitchen" },
  { filename: "photo_04.jpg", label: "Kitchen and Breakfast Bar", category: "Kitchen" },
  { filename: "photo_05.jpg", label: "Dining Area", category: "Living Areas" },
  { filename: "photo_06.jpg", label: "King Master Bedroom", category: "Bedrooms" },
  { filename: "photo_07.jpg", label: "Master Suite with Ceiling Fan", category: "Bedrooms" },
  { filename: "photo_08.jpg", label: "Master Bathroom", category: "Bathrooms" },
  { filename: "photo_09.jpg", label: "Queen Guest Room", category: "Bedrooms" },
  { filename: "photo_10.jpg", label: "Third Bedroom with Twins", category: "Bedrooms" },
  { filename: "photo_11.jpg", label: "Guest Bathroom", category: "Bathrooms" },
  { filename: "photo_12.jpg", label: "Covered Lanai", category: "Exterior" },
  { filename: "photo_13.jpg", label: "Lanai with Garden View", category: "Exterior" },
  { filename: "photo_14.jpg", label: "Community Pool", category: "Amenities" },
  { filename: "photo_15.jpg", label: "Pool and Tropical Gardens", category: "Amenities" },
  { filename: "photo_16.jpg", label: "Anini Beach Below", category: "Views" },
  { filename: "photo_17.jpg", label: "North Shore Coastline", category: "Views" },
  { filename: "photo_18.jpg", label: "Mountain and Ocean Panorama", category: "Views" },
  { filename: "photo_19.jpg", label: "Princeville Sunset", category: "Views" },
  { filename: "photo_20.jpg", label: "Princeville Golf Course", category: "Views" },
  { filename: "photo_21.jpg", label: "Hanalei Valley Lookout", category: "Views" },
  { filename: "photo_22.jpg", label: "North Shore Scenery", category: "Views" },
  { filename: "photo_23.jpg", label: "Community Grounds", category: "Exterior" },
  { filename: "photo_24.jpg", label: "Garden Paths", category: "Exterior" },
  { filename: "photo_25.jpg", label: "Outdoor Living", category: "Exterior" },
  { filename: "photo_26.jpg", label: "Tropical Landscape", category: "Exterior" },
  { filename: "photo_27.jpg", label: "Cliffside Ocean Views", category: "Views" },
];

const PHOTOS_PILI_MAI_UNIT_A: UnitPhoto[] = [
  { filename: "photo_00.jpg", label: "Living Room", category: "Living Areas" },
  { filename: "photo_01.jpg", label: "Interior — Great Room", category: "Living Areas" },
  { filename: "photo_02.jpg", label: "Interior — Dining Area", category: "Living Areas" },
  { filename: "photo_03.jpg", label: "Master Bedroom — King", category: "Bedrooms" },
  { filename: "photo_04.jpg", label: "Second Bedroom", category: "Bedrooms" },
  { filename: "photo_05.jpg", label: "Kitchen", category: "Kitchen" },
  { filename: "photo_06.jpg", label: "Bathroom", category: "Bathrooms" },
  { filename: "photo_07.jpg", label: "Covered Lanai", category: "Exterior" },
];

const PHOTOS_PILI_MAI_UNIT_B: UnitPhoto[] = [
  { filename: "photo_00.jpg", label: "Living Room", category: "Living Areas" },
  { filename: "photo_01.jpg", label: "Interior — Open Floor Plan", category: "Living Areas" },
  { filename: "photo_02.jpg", label: "Interior — Dining Area", category: "Living Areas" },
  { filename: "photo_03.jpg", label: "Master Bedroom — King", category: "Bedrooms" },
  { filename: "photo_04.jpg", label: "Second Bedroom", category: "Bedrooms" },
  { filename: "photo_05.jpg", label: "Kitchen", category: "Kitchen" },
  { filename: "photo_06.jpg", label: "Bathroom", category: "Bathrooms" },
  { filename: "photo_07.jpg", label: "Covered Lanai", category: "Exterior" },
];

export const unitBuilderData: PropertyUnitBuilder[] = [
  {
    propertyId: 1,
    propertyName: "Poipu Kai for large groups!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Bldg 8, Koloa, HI 96756",
    bookingTitle: "Poipu Kai - 7BR Resort - Sleeps 16",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of three spacious condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 7 bedrooms and can accommodate up to 19 guests, making this an ideal setup for large family reunions or group vacations on Kauai's sunny south shore.

Unit A is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) featuring a King bed in the master suite with jetted tub and walk-in marble shower, a Queen bed in the second bedroom, 2 Twins in the loft third bedroom, and a futon for additional sleeping. Central AC and an open-concept layout with granite kitchen make this a comfortable home base.

Unit B is a 2-bedroom, 2-bathroom ground-floor condo (~1,250 sq ft) with a modern renovation, Queen bed in the primary bedroom, King bed in the second bedroom, and a queen sleeper sofa. Two private balconies, stainless steel kitchen, and AC with ceiling fans throughout.

Unit C is a 2-bedroom, 2-bathroom condo (~1,250 sq ft) with central AC, King beds in both bedrooms, a queen sleeper sofa, smart TVs, and a private covered lanai. The fully stocked kitchen and large dining area are perfect for group meals.

All guests enjoy resort amenities including a sparkling pool, hot tub, tennis and pickleball courts, and tropical garden paths. Shipwreck Beach, Brennecke's Beach, and Poipu Beach Park are all within an easy 10-minute walk. Walking distance to Poipu Beach Park, Brennecke's Beach, and Shipwreck Beach. Nearby: Poipu Shopping Village, Kukui'ula Village (dining/shops), Spouting Horn blowhole, National Tropical Botanical Garden, Koloa Town historic district. Snorkeling at Poipu Beach, sea turtles, monk seals. Great restaurants including The Beach House, Merriman's, Tidepools.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Regency at Poipu Kai is tucked into Poipu, Kauai's sunniest and most popular resort area. Poipu Beach Park — consistently ranked one of America's best beaches — is a short drive away, with excellent snorkeling, sea turtle sightings, and a sheltered swimming area. Brenneckes Beach and Shipwreck Beach are nearby for bodyboarding and bodysurfing. Koloa Town, Kauai's oldest plantation village, is 5 minutes away with boutique shops, restaurants, and the Koloa Heritage Trail. Spouting Horn blowhole, the National Tropical Botanical Garden, and Moir Gardens round out the area's attractions.",
    transit: "A rental car is strongly recommended for exploring Kauai. Lihue Airport is approximately 25-30 minutes away. Koloa Town is 5 minutes by car. Waimea Canyon (Grand Canyon of the Pacific) is about 45 minutes west, and the North Shore is about an hour. Rideshare (Lyft) is available on Kauai but limited in frequency. The Kauai Bus provides budget public transport along main routes.",
        taxMapKey: "420150080001",
    tatLicense: "TA-023-450-1234-01",
    getLicense: "GE-023-450-1234-01",
    strPermit: "TVR-2022-048",
    hasPhotos: true,
    communityPhotos: COMMUNITY_REGENCY,
    communityPhotoFolder: "community-regency-poipu-kai",
    units: [
      {
        id: "unit-924",
        unitNumber: "924",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Elegant 3-bedroom, 3-bath Regency condo. Features Hawaiian-style furniture, granite kitchen, central AC, jetted tub in the master bath, and a walk-in marble shower. Sleeps 7 with King, Queen, 2 Twins, and a futon in the loft.",
        longDescription: `Welcome to this beautifully furnished 3-bedroom, 3-bathroom condominium at the Regency at Poipu Kai resort. This spacious approximately 1,800 sq ft home away from home features central air conditioning throughout and an inviting Hawaiian-style interior.

The open-concept living area flows from comfortable seating through a generous dining space to the fully equipped granite kitchen. A private lanai overlooks lush tropical gardens, perfect for morning coffee or evening relaxation. The great room design ensures everyone stays connected.

The gourmet kitchen features granite countertops, modern appliances, and everything you need to prepare meals for your group. A washer and dryer are conveniently located in the unit, along with beach chairs, towels, and coolers for your beach adventures.

The master bedroom offers a plush King bed and en-suite bathroom with a luxurious jetted tub and walk-in marble shower. The second bedroom features a comfortable Queen bed, while the third bedroom has 2 Twin beds. An upstairs loft with futon provides additional sleeping space.

Enjoy resort amenities including a sparkling swimming pool, hot tub, tennis and pickleball courts, and strolls through manicured tropical gardens. Shipwreck Beach, Brennecke's Beach, and Poipu Beach Park are all within a 10-minute walk.

Poipu's sunny south shore offers world-class snorkeling, surfing, and dining. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Watch for sea turtles and monk seals at the beach, and enjoy great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "unit-924",
        photos: PHOTOS_924,
      },
      {
        id: "unit-114",
        unitNumber: "114",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,250",
        maxGuests: 6,
        shortDescription: "Modern 2-bedroom, 2-bath ground-floor condo at the Regency at Poipu Kai. Features AC and ceiling fans, a renovated modern kitchen with stainless appliances, two private balconies, and an open floor plan. Sleeps 6 with Queen and King beds and a queen sleeper sofa.",
        longDescription: `Welcome to this stylishly renovated 2-bedroom, 2-bathroom ground-floor condominium at the Regency at Poipu Kai resort on Kauai's coveted south shore.

This approximately 1,250 sq ft condo has been thoughtfully updated with a modern aesthetic while maintaining its warm island charm. The open floor plan creates a spacious feel, with the living room flowing into the dining area and kitchen. Air conditioning and ceiling fans keep you comfortable year-round.

The modern kitchen features sleek stainless steel appliances, ample counter space, and is fully stocked with everything you need for home-cooked meals. Two private balconies provide outdoor living space to enjoy the tropical breezes and garden views.

The primary bedroom features a comfortable Queen bed with its own renovated en-suite bathroom with dual sinks. The second bedroom offers a King bed and is adjacent to the second full bathroom, also beautifully renovated. A queen sleeper sofa in the living area provides additional sleeping for two more guests. A convenient work area is available for those who need to stay connected.

As a Regency at Poipu Kai guest, you have full access to the resort pool, hot tub, tennis and pickleball courts, and lush tropical garden paths. Three world-class Poipu beaches are just a short 10-minute walk away.

From snorkeling at Poipu Beach Park to body surfing at Brennecke's Beach, or watching the sunset from Shipwreck Beach, this condo puts you in the heart of Kauai's best coastal experiences. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Great restaurants including The Beach House, Merriman's, and Tidepools are all close by.`,
        photoFolder: "unit-114",
        photos: PHOTOS_114,
      },
      {
        id: "unit-911",
        unitNumber: "911",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,250",
        maxGuests: 6,
        shortDescription: "Comfortable 2-bedroom, 2-bath Regency condo with central AC throughout. Features King beds in both rooms, a fully stocked kitchen, large dining area, private covered lanai, and smart TVs. Sleeps 6 with two King beds and a queen sleeper sofa.",
        longDescription: `Welcome to this well-appointed 2-bedroom, 2-bathroom condominium at the Regency at Poipu Kai resort. This unit features central air conditioning throughout for your complete comfort on Kauai's sunny south shore.

The approximately 1,250 sq ft interior offers a thoughtfully designed layout with a spacious living area, large dining area that seats the whole party, and a private covered lanai perfect for al fresco dining or simply soaking in the tropical garden views. Smart TVs in the living area and bedrooms provide entertainment options.

The fully stocked kitchen includes modern appliances, generous counter space, and all the cookware and utensils needed for everything from quick breakfasts to full dinners. The open layout connects the kitchen to the dining and living spaces for easy socializing.

The master bedroom features a plush King bed, smart TV, and en-suite bathroom with a soaking tub and separate shower. The second bedroom also offers a comfortable King bed and is adjacent to the second full bathroom, ideal for couples traveling together. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

Resort amenities await just steps from your door, including a gorgeous swimming pool, relaxing hot tub, and tennis and pickleball courts surrounded by tropical gardens. Shipwreck Beach, Brennecke's Beach, and Poipu Beach Park are all an easy 10-minute stroll.

Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Snorkel with sea turtles and watch for monk seals, or enjoy great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "unit-911",
        photos: PHOTOS_911,
      },
    ],
  },
  {
    propertyId: 4,
    propertyName: "Beautiful 6 Bedroom For 16 Villa in Poipu!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Koloa, HI 96756",
    bookingTitle: "Poipu Kai - 6BR Villas, Pool - Sleeps 16",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of two spacious 3-bedroom condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 6 bedrooms and can accommodate up to 16 guests, perfect for large groups exploring Kauai's sunny south shore.

Unit A is a 3-bedroom, 2.5-bathroom condo (~1,800 sq ft) with a covered dining lanai, open great room layout, fully equipped kitchen with breakfast bar, and a master suite with private lanai and en-suite bath. Sleeps 8 with a King bed, Queen bed, 2 Twins in the loft, and a queen sleeper sofa.

Unit B is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) featuring lovely garden views from the living room and lanai, a primary bedroom suite with private lanai and walk-in shower, and two additional guest bedrooms each with their own bath. Sleeps 8 with a King bed, Queen bed, 2 Twins, and a queen sleeper sofa.

All guests enjoy resort amenities including a swimming pool, hot tub, tennis and pickleball courts, and beautifully maintained tropical gardens. Shipwreck Beach, Brennecke's Beach, and Poipu Beach Park are all within a pleasant 10-minute walk. Walking distance to Poipu Shopping Village, Kukui'ula Village (dining/shops), Spouting Horn blowhole, National Tropical Botanical Garden, and Koloa Town historic district. Snorkeling at Poipu Beach, sea turtles, monk seals. Great restaurants including The Beach House, Merriman's, Tidepools.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Regency at Poipu Kai is tucked into Poipu, Kauai's sunniest and most popular resort area. Poipu Beach Park — consistently ranked one of America's best beaches — is a short drive away, with excellent snorkeling, sea turtle sightings, and a sheltered swimming area. Brenneckes Beach and Shipwreck Beach are nearby for bodyboarding and bodysurfing. Koloa Town, Kauai's oldest plantation village, is 5 minutes away with boutique shops, restaurants, and the Koloa Heritage Trail. Spouting Horn blowhole, the National Tropical Botanical Garden, and Moir Gardens round out the area's attractions.",
    transit: "A rental car is strongly recommended for exploring Kauai. Lihue Airport is approximately 25-30 minutes away. Koloa Town is 5 minutes by car. Waimea Canyon (Grand Canyon of the Pacific) is about 45 minutes west, and the North Shore is about an hour. Rideshare (Lyft) is available on Kauai but limited in frequency. The Kauai Bus provides budget public transport along main routes.",
        taxMapKey: "420150040002",
    tatLicense: "TA-023-450-1234-02",
    getLicense: "GE-023-450-1234-02",
    strPermit: "TVR-2021-031",
    hasPhotos: true,
    communityPhotos: COMMUNITY_REGENCY,
    communityPhotoFolder: "community-regency-poipu-kai",
    units: [
      {
        id: "unit-423",
        unitNumber: "423",
        bedrooms: 3,
        bathrooms: "2.5",
        sqft: "~1,800",
        maxGuests: 8,
        shortDescription: "Spacious 3-bedroom, 2.5-bath condo at the Regency at Poipu Kai resort. Features a covered dining lanai, open-plan living with great room, fully equipped kitchen with breakfast bar, master suite with private lanai and en-suite bath, plus two additional guest bedrooms including a loft and a queen sleeper sofa. Steps to pool, tennis courts, and three Poipu beaches.",
        longDescription: `Welcome to this beautifully appointed 3-bedroom, 2.5-bathroom condominium at the prestigious Regency at Poipu Kai resort on Kauai's sunny south shore.

This spacious approximately 1,800 sq ft condo features an inviting open floor plan with a generous great room that flows seamlessly from the living area through the dining space to the fully equipped kitchen. The covered dining lanai is perfect for enjoying tropical breezes and morning coffee.

The kitchen boasts modern appliances, ample counter space, and a breakfast bar for casual dining. The main living area offers comfortable seating with direct lanai access and abundant natural light.

The master bedroom suite includes a private lanai, walk-in closet, and en-suite bathroom with separate shower. The second guest bedroom provides a comfortable retreat, while the third bedroom is a charming open loft space with its own adjacent bath. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

Located within the Regency at Poipu Kai complex, guests enjoy access to resort amenities including swimming pool, tennis courts, and beautifully maintained tropical gardens. The property is just steps from three stunning Poipu beaches including Shipwreck Beach and Poipu Beach Park.

The complex is ideally situated near Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Enjoy snorkeling with sea turtles and monk seals, and dine at great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "unit-423",
        photos: PHOTOS_423,
      },
      {
        id: "unit-621",
        unitNumber: "621",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 8,
        shortDescription: "Beautiful 3-bedroom, 3-bath condo at the Regency at Poipu Kai resort. Features garden views from the living room and lanai, open-concept kitchen with breakfast bar, primary bedroom suite with private lanai and en-suite bath with walk-in shower, plus two additional guest bedrooms each with their own bath and a queen sleeper sofa. Steps to pool, tennis courts, and three Poipu beaches.",
        longDescription: `Welcome to this stunning 3-bedroom, 3-bathroom condominium at the sought-after Regency at Poipu Kai resort on Kauai's beautiful south shore.

This approximately 1,800 sq ft condo offers a light-filled open floor plan with lovely garden views from the main living area and lanai. The spacious great room seamlessly connects the living, dining, and kitchen areas for an ideal entertaining layout.

The fully equipped kitchen features modern appliances, generous counter space, and a breakfast bar perfect for casual meals. The open layout allows the cook to stay connected with family and guests while preparing meals.

The primary bedroom suite is a true retreat, featuring a private lanai overlooking the gardens, an en-suite bathroom with walk-in shower, and ample closet space. The second guest bedroom also enjoys garden views and has its own adjacent bathroom. The third bedroom is located in an upper loft area with its own bath, providing additional privacy. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

Guests enjoy full access to the Regency at Poipu Kai resort amenities including a swimming pool, tennis courts, and lushly landscaped tropical gardens. The complex is a short walk to three of Poipu's finest beaches, including world-famous Poipu Beach Park and Shipwreck Beach.

Located on Kauai's sunny south shore, you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district nearby. Enjoy snorkeling with sea turtles and monk seals, and dine at great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "unit-621",
        photos: PHOTOS_621,
      },
    ],
  },
  {
    propertyId: 7,
    propertyName: "Beautiful 8 brs for 22 near Poipu Beach Park!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Bldg 3, Koloa, HI 96756",
    bookingTitle: "Poipu Kai - 8BR Resort - Sleeps 22",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of three condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 8 bedrooms and can accommodate up to 21 guests, making this an exceptional option for large group gatherings on Kauai's beautiful south shore.

Unit A is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) with central AC, Hawaiian-style furnishings, a granite kitchen, and a spa-inspired master bath with jetted tub and walk-in marble shower. Sleeps 8 with a King bed, Queen bed, 2 Twins, and a queen sleeper sofa.

Unit B is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) featuring an expansive open floor plan, granite kitchen with breakfast bar, covered lanai, and AC in bedrooms. Sleeps 7 with a King bed, Queen bed, 2 Twins in the loft, and a sofa bed.

Unit C is a 2-bedroom, 2-bathroom ground-floor condo (~1,250 sq ft) with central AC throughout, King beds in both bedrooms, a queen sleeper sofa, and easy ground-level access to the pool and gardens. Sleeps 6.

All guests enjoy resort amenities including a sparkling pool, hot tub, tennis and pickleball courts, and tropical garden walkways. Poipu Beach Park, Brennecke's Beach, and Shipwreck Beach are all within a 10-minute walk. Walking distance to Poipu Shopping Village, Kukui'ula Village (dining/shops), Spouting Horn blowhole, National Tropical Botanical Garden, and Koloa Town historic district. Snorkeling at Poipu Beach, sea turtles, monk seals. Great restaurants including The Beach House, Merriman's, Tidepools.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Regency at Poipu Kai is tucked into Poipu, Kauai's sunniest and most popular resort area. Poipu Beach Park — consistently ranked one of America's best beaches — is a short drive away, with excellent snorkeling, sea turtle sightings, and a sheltered swimming area. Brenneckes Beach and Shipwreck Beach are nearby for bodyboarding and bodysurfing. Koloa Town, Kauai's oldest plantation village, is 5 minutes away with boutique shops, restaurants, and the Koloa Heritage Trail. Spouting Horn blowhole, the National Tropical Botanical Garden, and Moir Gardens round out the area's attractions.",
    transit: "A rental car is strongly recommended for exploring Kauai. Lihue Airport is approximately 25-30 minutes away. Koloa Town is 5 minutes by car. Waimea Canyon (Grand Canyon of the Pacific) is about 45 minutes west, and the North Shore is about an hour. Rideshare (Lyft) is available on Kauai but limited in frequency. The Kauai Bus provides budget public transport along main routes.",
        taxMapKey: "420150030001",
    tatLicense: "TA-023-450-1234-03",
    getLicense: "GE-023-450-1234-03",
    strPermit: "TVR-2021-029",
    hasPhotos: true,
    communityPhotos: COMMUNITY_REGENCY,
    communityPhotoFolder: "community-regency-poipu-kai",
    units: [
      {
        id: "unit-721",
        unitNumber: "721",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 8,
        shortDescription: "Charming 3-bedroom, 3-bath Regency condo with Hawaiian-style furnishings, granite kitchen, and central AC. Features a jetted tub, walk-in marble shower, garden views, and a private balcony. Sleeps 8 with King, Queen, 2 Twin beds, and a queen sleeper sofa.",
        longDescription: `Welcome to this tastefully decorated 3-bedroom, 3-bathroom condominium at the Regency at Poipu Kai resort. This unit boasts central air conditioning and authentic Hawaiian-style furniture that captures the spirit of the islands.

The approximately 1,800 sq ft interior features a welcoming open layout with the living room flowing into a spacious dining area and well-appointed kitchen. Granite countertops, modern appliances, and ample prep space make cooking a pleasure. A private balcony offers serene garden views and fresh tropical air.

Step into the master suite to find a luxurious King bed and a spa-inspired en-suite bathroom featuring a jetted soaking tub and walk-in marble shower. The second bedroom provides a restful Queen bed, while the third bedroom is outfitted with 2 Twin beds, ideal for children or friends. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

An upper loft area provides a flexible bonus space for reading, relaxing, or extra sleeping arrangements. Each of the three full bathrooms is well-appointed, ensuring comfort and privacy for all guests.

Resort living is at its finest with a sparkling pool, soothing hot tub, and tennis and pickleball courts just steps away. Tropical garden walkways connect you to the heart of the Regency at Poipu Kai complex.

Poipu Beach Park, Brennecke's Beach, and Shipwreck Beach are all within a leisurely 10-minute walk. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Enjoy snorkeling with sea turtles and monk seals, and dine at great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "unit-721",
        photos: PHOTOS_721,
      },
      {
        id: "unit-323",
        unitNumber: "323",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Spacious 3-bedroom, 3-bath Regency condo with a generous open floor plan, granite kitchen, covered lanai, and a loft bedroom. AC available in bedrooms. Sleeps 7 with King, Queen, 2 Twins, and a sofa bed.",
        longDescription: `Welcome to this spacious 3-bedroom, 3-bathroom condominium at the Regency at Poipu Kai resort on Kauai's sunny south shore. This unit offers a generous layout with comfortable island-inspired decor.

The approximately 1,800 sq ft interior showcases an expansive open floor plan where the living room, dining area, and kitchen flow together seamlessly. The covered lanai extends your living space outdoors, providing a shaded retreat surrounded by tropical landscaping.

The granite kitchen is fully equipped with modern appliances, a breakfast bar for casual meals, and plenty of counter space for preparing feasts. The open design keeps the cook connected with everyone in the great room.

The master bedroom suite features a plush King bed with private lanai access and an en-suite bathroom. The second bedroom offers a comfortable Queen bed, and the third bedroom in the loft area has 2 Twin beds plus its own adjacent bath. A sofa bed in the living area provides additional sleeping for a 7th guest. Bedrooms are equipped with AC for restful nights.

As a Regency at Poipu Kai guest, you have access to the resort's swimming pool, hot tub, tennis and pickleball courts, and beautifully maintained tropical gardens. The complex is ideally located near Poipu Shopping Village, Kukui'ula Village for dining and shops, and the historic Koloa Town district.

Three of Kauai's finest beaches are a short 10-minute walk away, including Poipu Beach Park for snorkeling and Shipwreck Beach for dramatic coastal scenery. Visit Spouting Horn blowhole and the National Tropical Botanical Garden, or enjoy great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "unit-423",
        photos: PHOTOS_423,
      },
      {
        id: "unit-811",
        unitNumber: "811",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,250",
        maxGuests: 6,
        shortDescription: "Well-appointed 2-bedroom, 2-bath ground-floor Regency condo with central AC, King beds in both rooms, a full kitchen, garden views, and a private lanai. Sleeps 6 with two King beds and a queen sleeper sofa.",
        longDescription: `Welcome to this comfortable 2-bedroom, 2-bathroom ground-floor condominium at the Regency at Poipu Kai resort. This unit features central air conditioning throughout, ensuring cool comfort on even the warmest Kauai days.

The approximately 1,250 sq ft layout is thoughtfully designed with an open living and dining area that connects to the fully equipped kitchen. Sliding doors open to a private lanai with peaceful garden views, bringing the outside in. Smart TVs are available for entertainment.

The kitchen comes fully stocked with modern appliances, cookware, and utensils for preparing anything from tropical smoothies to multi-course dinners. A generous dining area provides space for the whole group to gather over meals.

Both bedrooms feature luxurious King beds for a restful night's sleep. The master bedroom has its own en-suite bathroom, while the second bedroom is adjacent to the second full bath. A queen sleeper sofa in the living area provides additional sleeping for two more guests. The ground-floor location provides easy access to the pool and gardens.

Resort amenities include a beautiful swimming pool and hot tub, tennis and pickleball courts, and winding paths through tropical gardens. Everything is just steps from your front door in this well-maintained complex.

Poipu's famous beaches are a pleasant 10-minute walk, where you can snorkel with tropical fish, body surf at Brennecke's Beach, or watch monk seals bask at Poipu Beach Park. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Great restaurants including The Beach House, Merriman's, and Tidepools are all close by.`,
        photoFolder: "unit-911",
        photos: PHOTOS_911,
      },
    ],
  },
  {
    propertyId: 9,
    propertyName: "Spacious 5 Bedrooms in Poipu Kai! AC!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Bldg 6, Koloa, HI 96756",
    bookingTitle: "Poipu Kai - 5BR AC Villas - Sleeps 12",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of two condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 5 bedrooms and can accommodate up to 12 guests, a great option for families or groups looking for comfortable south shore accommodations with AC.

Unit A is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) with central AC, updated finishes, a granite kitchen, private balcony, and a loft bedroom. Sleeps 7 with a King bed, Queen bed, 2 Twins, and a sofa bed.

Unit B is a spacious corner 2-bedroom, 2-bathroom ground-floor condo (~1,400 sq ft) with central AC, extra natural light from the corner position, a Queen bed in the primary bedroom, and a King bed in the second bedroom. Sleeps 5.

All guests enjoy resort amenities including the swimming pool, hot tub, tennis and pickleball courts, and tropical garden paths. Poipu's beloved beaches are a short 10-minute walk from the resort. Walking distance to Poipu Beach Park, Brennecke's Beach, and Shipwreck Beach. Nearby: Poipu Shopping Village, Kukui'ula Village (dining/shops), Spouting Horn blowhole, National Tropical Botanical Garden, Koloa Town historic district. Snorkeling at Poipu Beach, sea turtles, monk seals. Great restaurants including The Beach House, Merriman's, Tidepools.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Regency at Poipu Kai is tucked into Poipu, Kauai's sunniest and most popular resort area. Poipu Beach Park — consistently ranked one of America's best beaches — is a short drive away, with excellent snorkeling, sea turtle sightings, and a sheltered swimming area. Brenneckes Beach and Shipwreck Beach are nearby for bodyboarding and bodysurfing. Koloa Town, Kauai's oldest plantation village, is 5 minutes away with boutique shops, restaurants, and the Koloa Heritage Trail. Spouting Horn blowhole, the National Tropical Botanical Garden, and Moir Gardens round out the area's attractions.",
    transit: "A rental car is strongly recommended for exploring Kauai. Lihue Airport is approximately 25-30 minutes away. Koloa Town is 5 minutes by car. Waimea Canyon (Grand Canyon of the Pacific) is about 45 minutes west, and the North Shore is about an hour. Rideshare (Lyft) is available on Kauai but limited in frequency. The Kauai Bus provides budget public transport along main routes.",
        taxMapKey: "420150060001",
    tatLicense: "TA-023-450-1234-05",
    getLicense: "GE-023-450-1234-05",
    strPermit: "TVR-2023-012",
    hasPhotos: true,
    communityPhotos: COMMUNITY_REGENCY,
    communityPhotoFolder: "community-regency-poipu-kai",
    units: [
      {
        id: "unit-723",
        unitNumber: "723",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Updated 3-bedroom, 3-bath Regency condo with central AC, granite kitchen, private balcony, loft bedroom, and garden views. Sleeps 7 with King, Queen, 2 Twins, and a sofa bed.",
        longDescription: `Welcome to this freshly updated 3-bedroom, 3-bathroom condominium at the Regency at Poipu Kai resort. This condo features central air conditioning and contemporary island-inspired interiors.

The approximately 1,800 sq ft home showcases updated finishes throughout, with a bright open floor plan that seamlessly connects the living room, dining area, and kitchen. A private balcony provides garden views and a quiet place to unwind with your morning coffee.

The full granite kitchen features modern appliances and generous counter space, making meal preparation a breeze. The open design keeps everyone together whether you are cooking, dining, or relaxing in the living area.

The master bedroom offers a King bed with en-suite bath, while the second bedroom features a Queen bed. The loft-level third bedroom has 2 Twin beds, and a sofa in the living area provides additional sleeping. Three full bathrooms ensure comfort and privacy for all guests.

Take advantage of the resort's sparkling pool, hot tub, and tennis and pickleball courts set among beautifully landscaped tropical gardens. The Regency at Poipu Kai complex provides a serene, resort-like atmosphere.

Kauai's famous south shore beaches are just a 10-minute walk away. Discover vibrant coral reefs at Poipu Beach Park, bodysurf the waves at Brennecke's Beach, or enjoy dramatic ocean views from Shipwreck Beach's coastal trail. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Watch for sea turtles and monk seals at the beach, and enjoy great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "unit-721",
        photos: PHOTOS_721,
      },
      {
        id: "unit-611",
        unitNumber: "611",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,400",
        maxGuests: 5,
        shortDescription: "Corner ground-floor 2-bedroom, 2-bath Regency condo with central AC, Queen and King beds, a modern kitchen, and a garden lanai. This spacious 1,400 sq ft unit sleeps 5.",
        longDescription: `Welcome to this spacious corner ground-floor 2-bedroom, 2-bathroom condominium at the Regency at Poipu Kai resort. This condo features central air conditioning and an extra-generous 1,400 sq ft layout thanks to its corner position.

The bright, airy interior features a modern open floor plan with the living area opening to a private garden lanai. The corner location provides additional windows and natural light, creating an especially welcoming atmosphere.

The modern kitchen is fully equipped with updated appliances, plenty of counter space, and all the essentials for preparing meals during your stay. The dining area comfortably seats your group for family meals.

The primary bedroom features a comfortable Queen bed with an en-suite bathroom, while the second bedroom offers a King bed adjacent to the second full bath. Both bedrooms are equipped with AC for cool, restful nights.

Enjoy resort amenities including the swimming pool, hot tub, tennis and pickleball courts, and tropical garden paths. The ground-floor location makes accessing the pool and gardens effortless.

Poipu's beloved beaches are a short 10-minute walk from the resort. Swim and snorkel at Poipu Beach Park, ride the shore break at Brennecke's Beach, or explore the dramatic coastline at Shipwreck Beach. The south shore's reliable sunshine makes Poipu the perfect vacation destination. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Watch for sea turtles and monk seals at the beach, and enjoy great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "unit-114",
        photos: PHOTOS_114,
      },
    ],
  },
  {
    propertyId: 10,
    propertyName: "Fabulous 5 br for 15 private beachfront Estate!",
    complexName: "Kekaha Beachfront Estate",
    address: "8497 Kekaha Rd, Kekaha, HI 96752",
    bookingTitle: "Kekaha - 5BR Beachfront - Sleeps 15",
    sampleDisclaimer: "This listing represents a managed beachfront estate property. Photos are representative and individual decor and furnishings may vary. Your specific accommodation will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards.",
    combinedDescription: `This listing includes a luxury beachfront home and a charming guest cottage, both located on the same oceanfront estate property in Kekaha on Kauai's sunny west side. Together they offer 5 bedrooms and can accommodate up to 15 guests, with direct beach access and spectacular Ni'ihau sunset views.

The Main House is a 3-bedroom, 2-bathroom oceanfront home (~2,000 sq ft) with Merbau wood floors, travertine bathrooms, and granite countertops. Every room opens to the oceanfront patio. Sleeps 9 with a King bed, 3 Queen beds, a Twin bed in the sunroom, and a queen sleeper sofa. AC in the master and second bedrooms.

The Guest Cottage is a completely renovated 1930s plantation-style cottage (~1,200 sq ft) with 2 bedrooms and 3 bathrooms, located right next to the main house on the same property. Two king master suites each have en-suite baths, and a queen sleeper sofa provides additional sleeping. AC in both bedrooms. Sleeps 6.

Both homes share the same pristine beachfront property with miles of white sand beach, BBQ, outdoor shower, and all beach amenities provided. Located on Kekaha Beach, one of Kauai's longest white sand beaches. Gateway to Waimea Canyon ("Grand Canyon of the Pacific") and Koke'e State Park. Near Waimea Town for dining and historic sites. Stunning sunsets over Ni'ihau island.

Important: This listing represents a managed beachfront estate property. Photos are representative and individual decor and furnishings may vary. Your specific accommodation details will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above.`,
    neighborhood: "Kekaha's West Side offers one of Hawaii's longest and most uncrowded white sand beaches stretching for miles with virtually no development in sight. It's a genuinely local Kauai experience away from resort crowds. Waimea Canyon — the \"Grand Canyon of the Pacific\" — is a 30-minute drive and an absolute must-see. Polihale State Park's remote beach is accessible nearby. Waimea Town is 10 minutes away for dining, groceries, and local color. The Russian Fort ruins and Captain Cook landing site monument are also in Waimea.",
    transit: "A rental car is essential on the West Side. Lihue Airport is approximately 45 minutes east. Waimea Canyon and Kokee State Park are 30 minutes by car. Polihale State Park requires a 4WD-friendly road. The Kauai Bus runs along the main highway but is limited in frequency. Rideshare is available but sparse in this area.",
        taxMapKey: "410090010001",
    tatLicense: "TA-022-410-5678-01",
    getLicense: "GE-022-410-5678-01",
    strPermit: "TVNC-0218",
    hasPhotos: true,
    communityPhotos: COMMUNITY_KEKAHA,
    communityPhotoFolder: "community-kekaha-estate",
    units: [
      {
        id: "prop10-kimsey-house",
        unitNumber: "Kimsey Beach House",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~2,000",
        maxGuests: 9,
        shortDescription: "Luxury 3-bedroom, 2-bath oceanfront home in Kekaha. Merbau wood floors, travertine bathrooms, granite countertops. Every room opens to the oceanfront patio, steps from the beach. AC in master and second bedrooms. Sleeps 9 with King, 3 Queens, Twin, and queen sleeper sofa.",
        longDescription: `Welcome to this luxury 3-bedroom, 2-bathroom oceanfront home in Kekaha on Kauai's sunny west side. This beautifully remodeled beach home puts you steps from miles of pristine white sand beach.

The home has been renovated with Merbau wood floors throughout, travertine bathrooms, and granite countertops. Every room features sliding glass doors that lead directly to the oceanfront patio and lanai, creating a seamless indoor-outdoor living experience with the sound of waves as your constant soundtrack.

The spacious great room flows from comfortable living areas through a generous dining space to the fully equipped modern kitchen, perfect for preparing family meals and entertaining. Two living areas provide plenty of space for your group to spread out.

The private master suite is separate from the other bedrooms for added privacy, featuring a King bed and an en-suite travertine bathroom with a double-head walk-in shower. The second bedroom has a Queen bed, and the third bedroom features two Queen beds. A sleeping sunroom with a twin bed and a queen sleeper sofa in the living area provide additional sleeping space. Split AC units cool the master and second bedrooms.

Enjoy spectacular Ni'ihau sunset views from the oceanfront patio. A BBQ, outdoor shower, and full laundry room are included. Beach towels, beach chairs, and all linens provided.

Located on Kekaha Beach, one of Kauai's longest white sand beaches and the sunniest spot on Kauai. Gateway to Waimea Canyon ("Grand Canyon of the Pacific") and Koke'e State Park. Near Waimea Town for dining and historic sites. Stunning sunsets over Ni'ihau island. Close to Polihale Beach and the beautiful Na Pali Coast.`,
        photoFolder: "kekaha-main",
        photos: PHOTOS_KEKAHA_MAIN,
      },
      {
        id: "prop10-kimsey-cottage",
        unitNumber: "Kimsey Beach Cottage",
        bedrooms: 2,
        bathrooms: "3",
        sqft: "~1,200",
        maxGuests: 6,
        shortDescription: "Charming renovated 1930s plantation cottage on the same oceanfront property. Two king master suites with en-suite baths, plus a queen sleeper sofa. Ocean and Ni'ihau views, AC in both bedrooms, full kitchen, and 3 bathrooms. Sleeps 6.",
        longDescription: `Welcome to this completely renovated 1930s plantation-style oceanfront cottage located right next to the main house on the same beachfront property in Kekaha.

This charming cottage retains its old Hawaii character while boasting all modern conveniences and comforts. Two master suites each feature a comfortable king-sized bed with their own en-suite bathrooms, plus a third full bathroom. Split AC units in both bedrooms keep you cool, and ceiling fans are located in every room.

The open living area features a queen-sized sleeper sofa for additional guests, and a separate sun room provides a peaceful reading nook. The fully equipped kitchen has everything you need for meal preparation, with views that look out over the ocean.

Sweeping ocean and Ni'ihau island views are visible from nearly every room. Step outside to the oceanfront lanai where you can watch surfers while enjoying your morning coffee.

Cable TV, DVD player, high-speed internet, gas grill, laundry room, and all linens and beach towels are included. This cottage can be rented alone or combined with the main house for larger groups.

Experience the authentic charm of old Hawaii plantation living with the comforts of a modern vacation home, all on one of Kauai's most beautiful and uncrowded beachfronts. Located on Kekaha Beach, one of Kauai's longest white sand beaches. Gateway to Waimea Canyon ("Grand Canyon of the Pacific") and Koke'e State Park. Near Waimea Town for dining and historic sites. Stunning sunsets over Ni'ihau island.`,
        photoFolder: "kekaha-cottage",
        photos: PHOTOS_KEKAHA_COTTAGE,
      },
    ],
  },
  {
    propertyId: 14,
    propertyName: "Fabulous 7 br 22 ocean view pool estate!",
    complexName: "Keauhou Estates",
    address: "78-6855 Ali'i Dr, Kailua-Kona, HI 96740",
    bookingTitle: "Keauhou - 6BR Luxury Estate - Sleeps 12",
    sampleDisclaimer: "This listing represents a managed estate property. Photos are representative and individual decor and furnishings may vary. Your specific accommodation will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards.",
    combinedDescription: `This listing includes a stunning custom estate home and a separate casita guest quarters, both located within the private, gated community of Keauhou Estates on the Big Island's Kona Coast. Together they offer 6 bedrooms and can accommodate up to 12 guests, with ocean views, a 72-foot saltwater lap pool, and zoned AC throughout.

The Main House is a breathtaking 4-bedroom, 4-bathroom custom estate (~4,000 sq ft) with each suite offering a private bath, king bed, and ocean views overlooking Kailua Bay. The spacious circular kitchen with soaring high ceilings is designed for entertaining, and multiple lanais provide sun-soaked and shaded relaxation spaces.

The Casita is a separate guest quarters (~800 sq ft) across the pool landing from the main house, with 2 bedrooms, 1 bathroom, king beds in each room, and individual AC units. Casita guests have full access to the main house kitchen, living areas, pool, and all outdoor amenities.

Located in exclusive Keauhou Estates near Keauhou Bay (manta ray night snorkeling), Magic Sands/La'aloa Beach Park, and Kahalu'u Beach (best easy snorkeling). Close to historic Kailua-Kona town (Ali'i Drive shopping/dining). Kona coffee country, Painted Church, Place of Refuge (Pu'uhonua o Honaunau). Deep sea fishing and whale watching (winter). Championship golf courses nearby.

Important: This listing represents a managed estate property. Photos are representative and individual decor and furnishings may vary. Your specific accommodation details will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above.`,
    neighborhood: "Ali'i Drive runs through the heart of Keauhou and Kailua-Kona, lined with oceanfront restaurants, snorkel spots, and historic Hawaiian sites. Kahaluu Beach Park — the Big Island's most popular snorkeling spot with sea turtles virtually guaranteed — is steps away. Magic Sands Beach (White Sands Beach) is minutes north. Kailua-Kona's waterfront offers diverse dining, fishing charters, the Kona Farmers Market, and historic Hulihe'e Palace. The vibrant Kona coffee belt and Holualoa artist village are a short drive up the hill.",
    transit: "A rental car is recommended for exploring the Big Island. Kona International Airport (KOA) is about 15 minutes north by car. Kailua-Kona town is a 5-10 minute drive or a scenic walk along Ali'i Drive. Hawaii Volcanoes National Park is approximately 90 minutes south — a must-do day trip. Mauna Kea summit is about 2 hours away. The Hele-On Bus provides limited public transport on the Big Island.",
        taxMapKey: "370110060001",
    tatLicense: "TA-018-920-3456-01",
    getLicense: "GE-018-920-3456-01",
    strPermit: "STVR-2019-003461",
    hasPhotos: true,
    communityPhotos: COMMUNITY_KEAUHOU,
    communityPhotoFolder: "community-keauhou-estates",
    units: [
      {
        id: "prop14-halelea-main",
        unitNumber: "Halele'a Main House",
        bedrooms: 4,
        bathrooms: "4",
        sqft: "~4,000",
        maxGuests: 8,
        shortDescription: "Stunning 4-bedroom, 4-bath custom estate in gated Keauhou Estates. Each suite has private bath, king bed, and ocean views. Circular kitchen with high ceilings, 72ft saltwater lap pool, zoned AC, and multiple lanais overlooking Kailua Bay.",
        longDescription: `Welcome to this breathtaking custom estate in the private, gated community of Keauhou Estates on the Big Island's Kona Coast.

This stunning custom estate features four main suites, each uniquely designed with a private bathroom, Roku-enabled TV, king-sized bed, and captivating ocean views overlooking Kailua Bay. The upstairs primary suite offers unparalleled luxury with a private lanai and an elegant en-suite bathroom featuring a bathtub and shower.

The spacious circular kitchen with soaring high ceilings was designed for entertaining and culinary creativity, fully equipped with modern appliances, a large island with stool seating, and ample counter space. Indoor and outdoor dining areas seat up to eight guests.

The expansive open-plan design features large windows and glass doors that invite natural light and ocean breezes. Multiple seating areas and multiple lanais offer both sun-soaked and shaded relaxation spaces with breathtaking tropical garden and ocean views.

The crown jewel is the designer saltwater pool, approximately 72 feet long and ideal for lap swimming, with an adjacent plunge pool for added relaxation. Positioned to enjoy sunlight from morning to sunset.

Zoned air conditioning ensures comfort throughout. Located in exclusive Keauhou Estates near Keauhou Bay (manta ray night snorkeling), Magic Sands/La'aloa Beach Park, and Kahalu'u Beach (best easy snorkeling). Close to historic Kailua-Kona town (Ali'i Drive shopping/dining). Kona coffee country, Painted Church, and Place of Refuge (Pu'uhonua o Honaunau). Deep sea fishing and whale watching (winter).`,
        photoFolder: "keauhou-estate",
        photos: PHOTOS_KEAUHOU,
      },
      {
        id: "prop14-halelea-casita",
        unitNumber: "Halele'a Casita",
        bedrooms: 2,
        bathrooms: "1",
        sqft: "~800",
        maxGuests: 4,
        shortDescription: "Private casita-style guest quarters across the pool landing from the main house. Two bedrooms with king beds, private bathroom, individual AC unit, and pool access. Perfect for couples or overflow guests.",
        longDescription: `This casita is a separate guest quarters located across a landing over the pool from the main house, within the same gated Keauhou Estates property.

This casita-style structure provides two additional bedrooms, each with a king bed, and a private bathroom. Individual AC units ensure comfortable sleeping. The casita offers a sense of privacy and seclusion while being just steps from the main house and its full amenities.

Guests in the casita have full access to the main house kitchen, living areas, the 72-foot saltwater lap pool, and all outdoor amenities including the BBQ area and multiple lanais.

The separate structure is ideal for couples who want their own private space, or for family members who appreciate a bit of independence while still being part of the group vacation experience.

From the casita, enjoy views of the tropical gardens, pool area, and ocean beyond. The gated Keauhou Estates community provides security and privacy. Near Keauhou Bay (manta ray night snorkeling), Magic Sands/La'aloa Beach Park, and Kahalu'u Beach (best easy snorkeling). Close to historic Kailua-Kona town (Ali'i Drive shopping/dining).`,
        photoFolder: "keauhou-estate",
        photos: PHOTOS_KEAUHOU,
      },
    ],
  },
  {
    propertyId: 19,
    propertyName: "Gorgeous Princeville 5 bedroom condos for 14!",
    complexName: "Mauna Kai Princeville",
    address: "3920 Wyllie Rd, Princeville, HI 96722",
    bookingTitle: "Princeville - 5BR Condos - Sleeps 14",
    sampleDisclaimer: "This listing represents a managed portfolio of similar units within Mauna Kai. The specific unit assigned will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards. Photos are representative and individual unit decor and furnishings may vary.",
    combinedDescription: `This listing is comprised of two comfortable condos within the Mauna Kai resort community in Princeville, just a short walk apart from each other within the complex. Together they offer 5 bedrooms and can accommodate up to 14 guests, providing a wonderful home base for exploring Kauai's spectacular North Shore.

Unit A is a bright two-story 3-bedroom, 2-bathroom condo (~1,600 sq ft) with mountain views, a fully equipped kitchen with granite counters, gas grill on the deck, and outdoor dining. Sleeps 8 with a King master, Queen second and third bedrooms, and a queen sofa bed. Central AC throughout.

Unit B is a comfortable ground-floor 2-bedroom, 2-bathroom condo (~1,200 sq ft) with garden views, a covered lanai, and a full kitchen. Sleeps 6 with Queen beds in both bedrooms and a sofa sleeper. Walkable to Princeville shops and restaurants.

Both units enjoy access to Mauna Kai's shared pool and hot tub. Hideaways Beach is just two miles away, Hanalei Bay is four miles, and the spectacular Na Pali Coast is accessible for scenic hiking nearby. Nearby: Queen's Bath tide pools, Princeville Makai Golf Course, Na Pali Coast boat tours, Kilauea Lighthouse, taro fields of Hanalei Valley. Fine dining at Makana Terrace, casual eats in Hanalei town.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Princeville perches atop dramatic cliffs on Kauai's North Shore with sweeping views of Hanalei Bay and the emerald peaks of the Napali Coast. Hanalei Town — 10 minutes away — is a charming beachside village with boutique surf shops, farm-to-table restaurants, and the iconic Hanalei Pier. Tunnels Beach (Makua) for snorkeling and Haena State Park (Kalalau Trail trailhead) are 20 minutes west. The Princeville Makai Golf Course, Queen's Bath tide pools, and Anini Beach are all nearby.",
    transit: "A rental car is essential on the North Shore. Lihue Airport is approximately 45 minutes south. Hanalei Town is 10 minutes west. Note that one-lane bridges along the North Shore road naturally slow traffic — allow extra time for exploring. The road ends at Haena State Park — advance reservations are required for the parking lot. Rideshare is available but limited on the North Shore.",
        taxMapKey: "450040020001",
    tatLicense: "TA-026-780-7890-01",
    getLicense: "GE-026-780-7890-01",
    strPermit: "TVR-2023-074",
    hasPhotos: true,
    communityPhotos: COMMUNITY_MAUNA_KAI,
    communityPhotoFolder: "community-mauna-kai",
    units: [
      {
        id: "prop19-mk-9",
        unitNumber: "9",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~1,600",
        maxGuests: 8,
        shortDescription: "Bright two-story 3BR/2BA condo with mountain views, shared pool and hot tub. Fully equipped kitchen with granite counters, gas grill on deck, and outdoor dining. King master, queen second and third bedrooms, plus queen sofa bed. Near Hideaways Beach.",
        longDescription: `Welcome to this spacious two-story condominium in the Mauna Kai resort community in Princeville on Kauai's North Shore.

This bright and airy condo features an open floor plan that seamlessly combines the kitchen, living room, and dining area into one large gathering space. Floor-to-ceiling windows bring in natural light and showcase the surrounding mountain and garden views.

The fully equipped kitchen features stainless steel appliances, gorgeous granite countertops, and all the cooking essentials for preparing meals during your stay. A gas grill on the deck allows for outdoor cooking, and the outdoor dining area and comfortable seating make the deck an extension of your living space.

The king-bedded master suite, queen-bedded second bedroom, and queen-bedded third bedroom provide comfortable sleeping for up to six. A queen sofa bed in the living area sleeps two more. Central AC keeps the entire unit comfortable.

Guests enjoy access to the shared outdoor pool and hot tub, perfect for relaxing after a day of North Shore adventures. Water sports gear is available for guest use.

Princeville offers jaw-dropping beaches, top golf courses, and breathtaking cliffs. Hideaways Beach is just two miles away, Hanalei Bay and its famous pier are four miles, and the spectacular Na Pali Coast is accessible for scenic hiking nearby. Nearby you'll find Queen's Bath tide pools, Princeville Makai Golf Course, Na Pali Coast boat tours, Kilauea Lighthouse, and the taro fields of Hanalei Valley. Fine dining at Makana Terrace and casual eats in Hanalei town.`,
        photoFolder: "mauna-kai-6a",
        photos: PHOTOS_MAUNA_KAI_6A,
      },
      {
        id: "prop19-mk-11",
        unitNumber: "11",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,200",
        maxGuests: 6,
        shortDescription: "Comfortable 2BR/2BA ground-floor condo with garden views, shared pool, full kitchen, and covered lanai. Queen beds in both bedrooms plus sofa sleeper. Walkable to Princeville shops and restaurants.",
        longDescription: `Welcome to this comfortable ground-floor 2-bedroom, 2-bathroom condominium in the Mauna Kai resort community in beautiful Princeville.

This well-maintained unit offers a relaxed island atmosphere with garden views from the covered lanai. The open floor plan creates a spacious feel, with comfortable living areas flowing into the fully equipped kitchen and dining space.

Both bedrooms feature queen beds with ceiling fans and their own adjacent bathrooms. A sofa sleeper in the living area accommodates additional guests. The kitchen is fully stocked with cookware, dishes, and modern appliances.

A covered lanai provides the perfect spot for morning coffee or evening relaxation. In-unit washer and dryer, WiFi, and cable TV are included.

Guests enjoy access to the Mauna Kai shared pool and BBQ area. The resort's convenient Princeville location puts you close to shopping, dining, and some of Kauai's most spectacular scenery.

Explore the golden sands of Hideaways Beach, snorkel at Queen's Bath, or venture to Hanalei for surfing and dining. The Na Pali Coast's dramatic cliffs and hiking trails are a short drive away. Nearby you'll find Princeville Makai Golf Course, Na Pali Coast boat tours, Kilauea Lighthouse, and the taro fields of Hanalei Valley. Fine dining at Makana Terrace and casual eats in Hanalei town.`,
        photoFolder: "mauna-kai-6a",
        photos: PHOTOS_MAUNA_KAI_6A,
      },
    ],
  },
  {
    propertyId: 20,
    propertyName: "Gorgeous Princeville 6 bedroom condos for 18!",
    complexName: "Mauna Kai Princeville",
    address: "3920 Wyllie Rd, Princeville, HI 96722",
    bookingTitle: "Princeville - 6BR Condos - Sleeps 18",
    sampleDisclaimer: "This listing represents a managed portfolio of similar units within Mauna Kai. The specific unit assigned will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards. Photos are representative and individual unit decor and furnishings may vary.",
    combinedDescription: `This listing is comprised of two spacious 3-bedroom condos within the Mauna Kai resort community in Princeville, just a short walk apart from each other within the complex. Together they offer 6 bedrooms and can accommodate up to 16 guests, perfect for large groups looking to experience Kauai's breathtaking North Shore.

Unit A is a 3-bedroom, 3-bathroom two-story condo (~1,600 sq ft) with central AC, a King master suite, Queen second and third bedrooms, a loft sleeping area, and a queen sleeper sofa. The open-concept living area opens to a covered lanai with tropical breezes and garden views.

Unit B is a bright 3-bedroom, 2-bathroom two-story condo (~1,600 sq ft) with garden and mountain views, a stainless steel kitchen with granite counters, and a lanai with comfortable seating. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa.

Both units enjoy access to Mauna Kai's shared pool and hot tub. Princeville's convenient location offers easy access to Hideaways Beach, Hanalei Bay, the Princeville golf courses, and the dramatic Na Pali Coast. Nearby: Queen's Bath tide pools, Princeville Makai Golf Course, Na Pali Coast boat tours, Kilauea Lighthouse, taro fields of Hanalei Valley. Fine dining at Makana Terrace, casual eats in Hanalei town.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Princeville perches atop dramatic cliffs on Kauai's North Shore with sweeping views of Hanalei Bay and the emerald peaks of the Napali Coast. Hanalei Town — 10 minutes away — is a charming beachside village with boutique surf shops, farm-to-table restaurants, and the iconic Hanalei Pier. Tunnels Beach (Makua) for snorkeling and Haena State Park (Kalalau Trail trailhead) are 20 minutes west. The Princeville Makai Golf Course, Queen's Bath tide pools, and Anini Beach are all nearby.",
    transit: "A rental car is essential on the North Shore. Lihue Airport is approximately 45 minutes south. Hanalei Town is 10 minutes west. Note that one-lane bridges along the North Shore road naturally slow traffic — allow extra time for exploring. The road ends at Haena State Park — advance reservations are required for the parking lot. Rideshare is available but limited on the North Shore.",
        taxMapKey: "450040020002",
    tatLicense: "TA-026-780-7890-02",
    getLicense: "GE-026-780-7890-02",
    strPermit: "TVR-2023-075",
    hasPhotos: true,
    communityPhotos: COMMUNITY_MAUNA_KAI,
    communityPhotoFolder: "community-mauna-kai",
    units: [
      {
        id: "prop20-mk-7b",
        unitNumber: "7B",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,600",
        maxGuests: 8,
        shortDescription: "Spacious 3BR/3BA two-story condo with ocean glimpses, shared pool, fully equipped kitchen, and covered lanai. King master suite, queen bedrooms, loft sleeping area, and queen sleeper sofa. Central AC throughout.",
        longDescription: `Welcome to this spacious 3-bedroom, 3-bathroom two-story condominium in Princeville's Mauna Kai resort. This well-appointed unit features central AC and a layout that maximizes space and privacy.

The main level features an open-concept living area with comfortable seating, a dining table, and a fully equipped kitchen. Sliding glass doors open to a covered lanai where you can enjoy the tropical breezes and garden views.

Three full bathrooms serve the three bedrooms. The king-bedded master suite includes an en-suite bath, while the second and third bedrooms feature queen beds. A loft area provides additional flexible sleeping space. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

The kitchen has everything you need for home cooking, from quality appliances to ample prep space. A washer and dryer in the unit add convenience.

Mauna Kai's shared pool and hot tub are just steps away. The resort location in Princeville puts you close to Hideaways Beach, the Princeville Botanical Gardens, and the gateway to the North Shore's most spectacular scenery.

From Hanalei Bay's famous crescent beach to the dramatic Na Pali Coast trails, Kauai's North Shore offers some of Hawaii's most breathtaking experiences right at your doorstep. Nearby you'll find Queen's Bath tide pools, Princeville Makai Golf Course, Na Pali Coast boat tours, Kilauea Lighthouse, and the taro fields of Hanalei Valley. Fine dining at Makana Terrace and casual eats in Hanalei town.`,
        photoFolder: "mauna-kai-t3",
        photos: PHOTOS_MAUNA_KAI_T3,
      },
      {
        id: "prop20-mk-8",
        unitNumber: "8",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~1,600",
        maxGuests: 8,
        shortDescription: "Airy 3BR/2BA two-story condo with garden and mountain views. Open floor plan, stainless kitchen, lanai with seating, shared pool. King, queen, and twin bedrooms plus queen sleeper sofa. Near Princeville shops and beaches.",
        longDescription: `Welcome to this bright and airy 3-bedroom, 2-bathroom two-story condo in Princeville's Mauna Kai resort community.

The open floor plan on the main level creates a wonderful gathering space where the kitchen, dining area, and living room flow together. Mountain and garden views from the windows and lanai remind you that you're in one of Hawaii's most beautiful locations.

The stainless steel kitchen is fully equipped for meal preparation, with granite counters and modern appliances. The lanai features comfortable seating for outdoor dining and relaxation.

The king-bedded master suite is on the main level with an en-suite bath. Two upstairs bedrooms offer a queen bed and twin beds respectively, sharing a full bath. A queen sleeper sofa in the living area provides additional sleeping for two more guests. WiFi, cable TV, in-unit washer/dryer, and all linens are included.

The shared pool and hot tub provide a refreshing retreat. Princeville's convenient location offers easy access to grocery stores, restaurants, and the Princeville golf courses.

Kauai's North Shore stretches before you with endless possibilities - from the turquoise waters of Anini Beach to the towering waterfalls along the Na Pali Coast. Hanalei's charming shops and restaurants are just a short drive away. Nearby you'll find Queen's Bath tide pools, Princeville Makai Golf Course, Na Pali Coast boat tours, Kilauea Lighthouse, and the taro fields of Hanalei Valley. Fine dining at Makana Terrace and casual eats in Hanalei town.`,
        photoFolder: "mauna-kai-t3",
        photos: PHOTOS_MAUNA_KAI_T3,
      },
    ],
  },
  {
    propertyId: 23,
    propertyName: "Incredible 5 bedrooms for 14 at Lydgate Beach!",
    complexName: "Kaha Lani Resort",
    address: "4460 Nehe Rd, Lihue, HI 96766",
    bookingTitle: "Kaha Lani - 5BR Oceanfront - Sleeps 14",
    sampleDisclaimer: "This listing represents a managed portfolio of similar units within Kaha Lani Resort. The specific unit assigned will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards. Photos are representative and individual unit decor and furnishings may vary.",
    combinedDescription: `This listing is comprised of two oceanfront condos within the Kaha Lani Resort in Kapaa, just a short walk apart from each other within the complex. Together they offer 5 bedrooms and can accommodate up to 14 guests, with stunning ocean views and steps to family-friendly Lydgate Beach Park.

Unit A is a spacious 3-bedroom, 3-bathroom oceanfront condo (~1,700 sq ft) with an open floor plan, ocean views from the lanai, and AC throughout. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa.

Unit B is a comfortable 2-bedroom, 2-bathroom ocean view condo (~1,200 sq ft) with a renovated kitchen, private lanai with ocean views, and a relaxing tropical retreat feel. Sleeps 6 with a King master, Queen second bedroom, and a sofa sleeper.

Kaha Lani Resort features a pool, hot tub, and BBQ area. The resort sits directly adjacent to Lydgate Beach Park with its protected swimming lagoon and Kamalani Playground. On the Coconut Coast with Kapa'a Beach Park, Lydgate Beach (protected swimming), and Coconut MarketPlace nearby. Easy access to Wailua Falls, Opaeka'a Falls, and Wailua River kayaking. Kapaa's charming town center offers eclectic shopping, dining, and the scenic coastal bike path.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Kaha Lani Resort sits directly on the Coconut Coast in Kapaa, steps from Lydgate Beach Park — one of Kauai's best family beaches featuring a protected ocean swimming lagoon, snorkeling, and the beloved Kamalani Playground. The scenic Kauai Path coastal bike trail runs past the property, connecting Kapaa Town and the surrounding coast. Kapaa Town is 5 minutes north with eclectic local dining, farmers markets, and boutique shops. Wailua Falls, Opaeka'a Falls, and Wailua River kayaking are all within 15 minutes inland.",
    transit: "The Coconut Coast location is Kauai's most central — Lihue Airport is about 15 minutes south, the North Shore (Hanalei) is 40 minutes north, and the South Shore (Poipu) is about 40 minutes south. A rental car is recommended, though groceries and dining are walkable in Kapaa. The Kauai Path bike trail runs right outside the resort. Rideshare (Lyft) and The Kauai Bus are both available in this area.",
        taxMapKey: "430150130001",
    tatLicense: "TA-024-630-2345-01",
    getLicense: "GE-024-630-2345-01",
    strPermit: "TVNC-0342",
    hasPhotos: true,
    communityPhotos: COMMUNITY_KAHA_LANI,
    communityPhotoFolder: "community-kaha-lani",
    units: [
      {
        id: "prop23-kl-3br",
        unitNumber: "339",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,700",
        maxGuests: 8,
        shortDescription: "Spacious 3BR/3BA oceanfront condo at Kaha Lani Resort. Open floor plan, fully equipped kitchen, private lanai with ocean views. King master, queen second, twins third, and queen sleeper sofa. Steps to Lydgate Beach and playground. AC throughout.",
        longDescription: `Welcome to this spacious 3-bedroom, 3-bathroom oceanfront condominium at the Kaha Lani Resort in Kapaa on Kauai's Coconut Coast.

This well-appointed condo features an open floor plan with ocean views from the main living areas and private lanai. The fully equipped kitchen has modern appliances, granite counters, and everything needed for meal preparation. The dining area seats your full group comfortably.

The king-bedded master suite includes an en-suite bathroom and ocean views. The second bedroom offers a queen bed, and the third bedroom has twin beds - both with adjacent bathrooms. A queen sleeper sofa in the living area provides additional sleeping for two more guests. AC throughout keeps you comfortable in Kapaa's tropical climate.

The private lanai is perfect for morning coffee while watching the sunrise over the Pacific. A washer/dryer, WiFi, cable TV, and all linens are included.

Kaha Lani Resort features a pool, hot tub, and BBQ area. The resort sits directly adjacent to Lydgate Beach Park, one of Kauai's best family beaches with a protected swimming lagoon, snorkeling, and the expansive Kamalani Playground.

Kapaa's Coconut Coast is centrally located on Kauai, making it easy to explore both the North Shore and South Shore. The charming Kapaa town offers eclectic shopping, dining, and the scenic coastal bike path. Easy access to Wailua Falls, Opaeka'a Falls, and Wailua River kayaking. Local restaurants, shops, and the Kauai Path along the coast make this an ideal home base.`,
        photoFolder: "kaha-lani-109",
        photos: PHOTOS_KAHA_LANI_109,
      },
      {
        id: "prop23-kl-2br",
        unitNumber: "221",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,200",
        maxGuests: 6,
        shortDescription: "Ocean view 2BR/2BA condo at Kaha Lani Resort. Renovated kitchen, comfortable living areas, and a private lanai overlooking the ocean. King master and queen second bedroom. Steps to Lydgate Beach.",
        longDescription: `Welcome to this comfortable 2-bedroom, 2-bathroom ocean view condominium at the Kaha Lani Resort in Kapaa.

This well-maintained unit features a renovated kitchen with modern appliances and granite counters. The open living and dining area flows to a private lanai with ocean views, creating a relaxing tropical retreat.

The king-bedded master suite has an en-suite bathroom, and the queen-bedded second bedroom is adjacent to the second full bath. A sofa sleeper in the living area provides space for additional guests. WiFi, cable TV, washer/dryer, and all linens included.

Take advantage of Kaha Lani Resort's pool, hot tub, and BBQ facilities. Walk directly to Lydgate Beach Park's protected swimming lagoon, ideal for families with its calm waters and abundant sea life.

Kapaa town is minutes away with its bike path, shopping, and diverse dining options. The Coconut Coast location provides easy access to Wailua Falls, Opaeka'a Falls, and Wailua River kayaking. Local restaurants, shops, and the Kauai Path along the coast are all nearby.`,
        photoFolder: "kaha-lani-123",
        photos: PHOTOS_KAHA_LANI_123,
      },
    ],
  },
  {
    propertyId: 24,
    propertyName: "Gorgeous 5 bedroom condos for 10 on Kapaa coast!",
    complexName: "Lae Nani Resort",
    address: "410 Papaloa Rd, Kapaa, HI 96746",
    bookingTitle: "Lae Nani - 5BR Oceanfront - Sleeps 10",
    sampleDisclaimer: "This listing represents a managed portfolio of similar units within Lae Nani Resort. The specific unit assigned will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards. Photos are representative and individual unit decor and furnishings may vary.",
    combinedDescription: `This listing is comprised of two oceanfront condos within the Lae Nani Resort in Kapaa, just a short walk apart from each other within the complex. Together they offer 5 bedrooms and can accommodate up to 14 guests, with ocean views and access to the resort's own private sandy beach cove.

Unit A is an oceanfront 3-bedroom, 2-bathroom corner condo (~1,500 sq ft) with expansive ocean views, a full kitchen, and a private lanai. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa. AC and ceiling fans throughout.

Unit B is a charming 2-bedroom, 2-bathroom condo (~1,100 sq ft) set in a tropical garden with ocean views, a full kitchen, and a private lanai. Sleeps 6 with a King master, Queen second bedroom, and a queen sleeper sofa. AC and ceiling fans included.

Lae Nani Resort sits on a rocky oceanfront point with a private beach cove perfect for swimming and snorkeling. The resort pool, tennis court, and BBQ area round out the amenities. On the Coconut Coast with easy access to Wailua Falls, Opaeka'a Falls, and Wailua River kayaking. Kapaa's vibrant town center is walking distance with its coastal bike path, boutiques, and diverse restaurants.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Lae Nani Resort occupies a prime oceanfront position on the Coconut Coast in Kapaa, with a private tidal pool area and direct ocean access. The Kauai Path coastal bike trail passes by the property. Kapaa Town — minutes away — offers diverse restaurants, the Saturday morning farmers market, boutique shopping, and a lively local vibe. Wailua River kayaking, Wailua Falls, and Opaeka'a Falls scenic overlook are 10-15 minutes inland. Coconut Marketplace and Kauai Village Shopping Center are nearby for convenience.",
    transit: "Lihue Airport is about 15 minutes south. The Coconut Coast sits midway between Kauai's North Shore and South Shore — each roughly 35-40 minutes by car. A rental car is recommended. The Kauai Path bike trail connects the coastal area for car-free exploring. Rideshare (Lyft) and The Kauai Bus are both accessible from Kapaa.",
        taxMapKey: "440080010001",
    tatLicense: "TA-025-110-4567-01",
    getLicense: "GE-025-110-4567-01",
    strPermit: "TVNC-0489",
    hasPhotos: true,
    communityPhotos: COMMUNITY_LAE_NANI,
    communityPhotoFolder: "community-lae-nani",
    units: [
      {
        id: "prop24-ln-3br",
        unitNumber: "314",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~1,500",
        maxGuests: 8,
        shortDescription: "Oceanfront 3BR/2BA condo at Lae Nani Resort. Open living with ocean views, full kitchen, private lanai, pool and tennis. King master, queen and twin bedrooms plus queen sleeper sofa. Steps to a private sandy beach cove.",
        longDescription: `Welcome to this oceanfront 3-bedroom, 2-bathroom condominium at the Lae Nani Resort in Kapaa on Kauai's beautiful Coconut Coast.

This corner unit offers expansive ocean views from the living area and private lanai. The open layout creates a bright, airy space with the kitchen, dining, and living areas flowing together.

The fully equipped kitchen features modern appliances and plenty of counter space. The king-bedded master suite has an en-suite bath and ocean views. The second bedroom offers a queen bed, and the third bedroom has twin beds. A queen sleeper sofa in the living area provides additional sleeping for two more guests. AC and ceiling fans keep all rooms comfortable.

Lae Nani Resort sits on a rocky oceanfront point with its own private sandy beach cove - perfect for swimming and snorkeling. The resort pool, tennis court, and BBQ area provide additional amenities.

Kapaa's vibrant town center is walking distance, offering the popular coastal bike path, eclectic boutiques, farmers markets, and diverse restaurants. Easy access to Wailua Falls, Opaeka'a Falls, and Wailua River kayaking. Central Kauai location makes day trips to any part of the island easy and convenient.`,
        photoFolder: "lae-nani-335",
        photos: PHOTOS_LAE_NANI,
      },
      {
        id: "prop24-ln-2br",
        unitNumber: "225",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,100",
        maxGuests: 6,
        shortDescription: "Charming 2BR/2BA condo at Lae Nani Resort with ocean views, tropical garden setting, full kitchen, and lanai. King and queen bedrooms plus queen sleeper sofa. Private beach cove, pool, and tennis court.",
        longDescription: `Welcome to this charming 2-bedroom, 2-bathroom condominium at the Lae Nani Resort in Kapaa.

Set in a tropical garden with ocean views, this comfortable condo features a full kitchen, spacious living and dining areas, and a private lanai. The king-bedded master has an en-suite bath, and the queen-bedded second bedroom is near the second bath. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

WiFi, cable TV, ceiling fans, AC, and all linens are included. An in-unit washer/dryer adds convenience.

Lae Nani's private beach cove offers some of the best swimming on Kauai's east side. The resort pool, tennis court, and landscaped grounds provide a relaxing base for your Kauai vacation.

Walk to Kapaa town for shopping, dining, and the scenic coastal bike path. Easy access to Wailua Falls, Opaeka'a Falls, and Wailua River kayaking. The central location makes exploring Waimea Canyon, the North Shore, and Poipu equally accessible.`,
        photoFolder: "lae-nani-335",
        photos: PHOTOS_LAE_NANI,
      },
    ],
  },
  {
    propertyId: 26,
    propertyName: "Fabulous 7 bedroom for 23 near Magic Sands Beach!",
    complexName: "Keauhou Estates",
    address: "78-6920 Ali'i Dr, Kailua-Kona, HI 96740",
    bookingTitle: "Keauhou - 7BR Luxury Estate - Sleeps 23",
    sampleDisclaimer: "This listing represents a managed estate property. Photos are representative and individual decor and furnishings may vary. Your specific accommodation will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards.",
    combinedDescription: `This listing includes a grand main estate home and a separate guest wing, both located on the same property within the exclusive gated community of Keauhou Estates on the Big Island's stunning Kona Coast. Together they offer 7 bedrooms and can accommodate up to 23 guests, with a private pool, ocean views, and zoned AC throughout.

The Main Estate is a grand 5-bedroom, 5-bathroom home (~4,500 sq ft) with five en-suite king bedrooms, a gourmet kitchen with professional-grade appliances, high ceilings, and floor-to-ceiling ocean-view windows. The private pool area is the centerpiece of the outdoor space, surrounded by tropical landscaping and views of Kailua Bay. Sleeps 15.

The Guest Wing is a separate living space (~900 sq ft) within the estate grounds, offering 2 bedrooms with king beds, a private bathroom, AC, and lanai access. Guest wing occupants enjoy full access to the main estate's kitchen, living areas, pool, and outdoor amenities. Sleeps 8.

Located in the gated Keauhou Estates community with 24-hour security. Near Keauhou Bay (manta ray night snorkeling), Magic Sands/La'aloa Beach Park, and Kahalu'u Beach (best easy snorkeling). Close to historic Kailua-Kona town (Ali'i Drive shopping/dining). Kona coffee country, Painted Church, Place of Refuge (Pu'uhonua o Honaunau). Deep sea fishing and whale watching (winter). Championship golf courses nearby.

Important: This listing represents a managed estate property. Photos are representative and individual decor and furnishings may vary. Your specific accommodation details will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above.`,
    neighborhood: "Ali'i Drive runs through the heart of Keauhou and Kailua-Kona, lined with oceanfront restaurants, snorkel spots, and historic Hawaiian sites. Kahaluu Beach Park — the Big Island's most popular snorkeling spot with sea turtles virtually guaranteed — is steps away. Magic Sands Beach (White Sands Beach) is minutes north. Kailua-Kona's waterfront offers diverse dining, fishing charters, the Kona Farmers Market, and historic Hulihe'e Palace. The vibrant Kona coffee belt and Holualoa artist village are a short drive up the hill.",
    transit: "A rental car is recommended for exploring the Big Island. Kona International Airport (KOA) is about 15 minutes north by car. Kailua-Kona town is a 5-10 minute drive or a scenic walk along Ali'i Drive. Hawaii Volcanoes National Park is approximately 90 minutes south — a must-do day trip. Mauna Kea summit is about 2 hours away. The Hele-On Bus provides limited public transport on the Big Island.",
        taxMapKey: "370110070001",
    tatLicense: "TA-018-920-3456-02",
    getLicense: "GE-018-920-3456-02",
    strPermit: "STVR-2019-003462",
    hasPhotos: true,
    communityPhotos: COMMUNITY_KEAUHOU,
    communityPhotoFolder: "community-keauhou-estates",
    units: [
      {
        id: "prop26-estate-main",
        unitNumber: "Main Estate",
        bedrooms: 5,
        bathrooms: "5",
        sqft: "~4,500",
        maxGuests: 15,
        shortDescription: "Grand 5-bedroom, 5-bath estate in gated Keauhou Estates with private pool, ocean views, and gourmet kitchen. Each bedroom has a king bed and private bath. Zoned AC throughout. Near Magic Sands Beach.",
        longDescription: `Welcome to this grand 5-bedroom, 5-bathroom estate within the exclusive gated community of Keauhou Estates on the Big Island's stunning Kona Coast.

This expansive custom home was designed for luxury entertaining and family gatherings. Five en-suite bedrooms each feature king beds and private bathrooms, ensuring comfort and privacy for all guests. Zoned air conditioning keeps every room at your preferred temperature.

The gourmet kitchen is a chef's dream with professional-grade appliances, extensive counter space, and a large island perfect for casual dining or meal prep for the whole group. The open-plan living and dining areas feature high ceilings, designer furnishings, and floor-to-ceiling windows framing spectacular ocean views.

Multiple lanais offer outdoor living spaces with ocean-facing views, lounge seating, and al fresco dining. The private pool area is the centerpiece of the outdoor space, surrounded by lush tropical landscaping and views of Kailua Bay.

A private 2-car garage, outdoor BBQ area, beach towels, snorkel gear, and beach chairs are provided. The gated community offers 24-hour security with friendly gate staff.

Near Keauhou Bay (manta ray night snorkeling), Magic Sands/La'aloa Beach Park, and Kahalu'u Beach (best easy snorkeling). Close to historic Kailua-Kona town (Ali'i Drive shopping/dining). Kona coffee country, Painted Church, and Place of Refuge (Pu'uhonua o Honaunau). Deep sea fishing and whale watching (winter). Championship golf courses nearby.`,
        photoFolder: "keauhou-estate",
        photos: PHOTOS_KEAUHOU,
      },
      {
        id: "prop26-estate-guest",
        unitNumber: "Guest Wing",
        bedrooms: 2,
        bathrooms: "1",
        sqft: "~900",
        maxGuests: 8,
        shortDescription: "Separate guest wing with 2 bedrooms and private bathroom, providing independence while sharing the estate's pool, kitchen, and living areas. King beds, AC, and lanai access.",
        longDescription: `The Guest Wing at this Keauhou Estates property provides a separate living space within the estate grounds, offering privacy and independence while maintaining easy access to all the main house amenities.

Two comfortable bedrooms each feature king beds and air conditioning. A private bathroom serves the guest wing exclusively. Direct lanai access allows guests to step outside to enjoy the tropical gardens and ocean breezes.

Guest wing occupants have full access to the main estate's gourmet kitchen, living areas, private pool, and outdoor amenities. The separation is ideal for multi-generational family trips or groups who appreciate having their own private space.

The Keauhou Estates gated community provides a secure, peaceful environment. Near Keauhou Bay (manta ray night snorkeling), Magic Sands/La'aloa Beach Park, and Kahalu'u Beach (best easy snorkeling). Close to historic Kailua-Kona town (Ali'i Drive shopping/dining). Kona coffee country and championship golf courses nearby.`,
        photoFolder: "keauhou-estate",
        photos: PHOTOS_KEAUHOU,
      },
    ],
  },
  {
    propertyId: 28,
    propertyName: "Beautiful ocean view Poipu 7 brs for 17! 60 yards to Beach!",
    complexName: "Poipu Brenneckes Beachside",
    address: "2298 Ho'one Rd, Koloa, HI 96756",
    bookingTitle: "Poipu - 7BR Ocean View Homes - Sleeps 17",
    sampleDisclaimer: "This listing represents a managed portfolio of similar beachside homes. The specific home assigned will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards. Photos are representative and individual decor and furnishings may vary.",
    combinedDescription: `This listing includes two beachside homes located on the same property, just 60 yards from famous Brennecke's Beach on Kauai's sunny Poipu coast. Together they offer 7 bedrooms and can accommodate up to 17 guests, with ocean views and an unbeatable beach location.

Beach House A is a spacious 4-bedroom, 3-bathroom home (~2,200 sq ft) with an open floor plan, ocean views, a covered lanai, and tropical landscaping. Sleeps 10 with a King master suite, Queen and Twin bedrooms, and a queen sleeper sofa. AC and ceiling fans throughout.

Beach House B is a charming 3-bedroom, 3-bathroom home (~1,800 sq ft) with island-style decor and the luxury of private bathrooms for each bedroom. Sleeps 7 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa. Covered lanai with ocean views and a BBQ grill.

The location is unbeatable - Brennecke's Beach for world-class body surfing, Poipu Beach Park for calm-water snorkeling, and Shipwreck Beach's dramatic coastline are all within a short walk. Nearby: Poipu Shopping Village, Kukui'ula Village (dining/shops), Spouting Horn blowhole, National Tropical Botanical Garden, Koloa Town historic district. Great restaurants including The Beach House, Merriman's, and Tidepools.

Important: This listing represents our managed portfolio of similar properties. Your specific accommodation will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual decor and furnishings may vary.`,
    neighborhood: "This property sits just steps from Brenneckes Beach, one of Kauai's best bodyboarding spots, and a short walk from Poipu Beach Park, where sea turtles rest on the sand and excellent snorkeling awaits. Poipu is the sunniest part of Kauai with rare rain and warm year-round temperatures. Koloa Town — Kauai's oldest plantation village — is 5 minutes away for local dining and boutique shopping. Spouting Horn blowhole, the National Tropical Botanical Garden, and Moir Gardens are all nearby.",
    transit: "A rental car is recommended on the South Shore. Lihue Airport is approximately 30 minutes away. Koloa Town is 5 minutes by car. Waimea Canyon is about 45 minutes west. Rideshare (Lyft) is available but less frequent than in larger cities. The Kauai Bus serves the South Shore on limited routes.",
        taxMapKey: "420170030001",
    tatLicense: "TA-023-910-6789-01",
    getLicense: "GE-023-910-6789-01",
    strPermit: "TVR-2023-058",
    hasPhotos: true,
    communityPhotos: COMMUNITY_POIPU_BEACHSIDE,
    communityPhotoFolder: "community-poipu-beachside",
    units: [
      {
        id: "prop28-house-a",
        unitNumber: "Beach House A",
        bedrooms: 4,
        bathrooms: "3",
        sqft: "~2,200",
        maxGuests: 10,
        shortDescription: "Ocean view 4-bedroom, 3-bath home just 60 yards from Brennecke's Beach. Open floor plan, fully equipped kitchen, covered lanai with ocean views, and tropical landscaping. King master suite, queen and twin bedrooms, and queen sleeper sofa.",
        longDescription: `Welcome to this spacious 4-bedroom, 3-bathroom home located just 60 yards from famous Brennecke's Beach on Kauai's sunny south shore.

This well-appointed home features an open floor plan with the living room, dining area, and kitchen flowing together to create a perfect gathering space. Large windows frame ocean views, and the covered lanai extends your living space outdoors with comfortable seating and dining.

The fully equipped kitchen has everything needed for meal preparation, from modern appliances to a full complement of cookware and serving ware. The dining area comfortably seats your group.

The king-bedded master suite includes a private en-suite bathroom. Additional bedrooms offer queen and twin bed configurations with two more full bathrooms. A queen sleeper sofa in the living area provides additional sleeping for two more guests. AC and ceiling fans keep all rooms comfortable. WiFi, cable TV, washer/dryer, and all linens provided.

Step outside and walk to Brennecke's Beach in just minutes for world-class body surfing and boogie boarding. Poipu Beach Park is equally close for calm-water swimming and snorkeling. Shipwreck Beach's dramatic cliffs are a short walk along the coast.

The Poipu area offers excellent dining, shopping, and the National Tropical Botanical Garden. This is Kauai's premier resort coast with the island's most consistent sunny weather. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, and the historic Koloa Town district. Watch for sea turtles and monk seals at the beach, and enjoy great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "poipu-beachside",
        photos: PHOTOS_POIPU_BEACHSIDE,
      },
      {
        id: "prop28-house-b",
        unitNumber: "Beach House B",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Charming 3-bedroom, 3-bath home steps from Brennecke's Beach. Island-style decor, lanai with ocean views, full kitchen, and private bathrooms for each bedroom. King, queen, and twin beds, plus queen sleeper sofa.",
        longDescription: `Welcome to this charming 3-bedroom, 3-bathroom home located steps from Brennecke's Beach on Poipu's renowned south shore.

Island-style decor and comfortable furnishings create a welcoming atmosphere throughout this well-maintained home. Each of the three bedrooms has its own private bathroom - a rare luxury that ensures comfort for all guests.

The king-bedded master, queen second bedroom, and twin-bedded third bedroom provide comfortable sleeping. A queen sleeper sofa in the living area provides additional sleeping for two more guests. The open living area connects to a full kitchen with modern appliances and a dining area. The covered lanai offers ocean views and outdoor dining.

AC, ceiling fans, WiFi, cable TV, washer/dryer, beach chairs, beach towels, and all linens are provided. A BBQ grill on the lanai makes outdoor cooking a pleasure.

The location is unbeatable - Brennecke's Beach, Poipu Beach Park, and Shipwreck Beach are all within a short walk. Enjoy some of Hawaii's best snorkeling, body surfing, and sunset watching right at your doorstep. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Great restaurants including The Beach House, Merriman's, and Tidepools are all close by.`,
        photoFolder: "poipu-beachside",
        photos: PHOTOS_POIPU_BEACHSIDE,
      },
    ],
  },
  {
    propertyId: 29,
    propertyName: "Ocean view 7 bedrooms for 14 above Anini Beach!",
    complexName: "Kaiulani of Princeville",
    address: "4100 Queen Emma's Dr, Princeville, HI 96722",
    bookingTitle: "Princeville - 7BR Ocean View - Sleeps 14",
    sampleDisclaimer: "This listing represents a managed portfolio of similar townhome units within Kaiulani of Princeville. The specific unit assigned will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards. Photos are representative and individual unit decor and furnishings may vary.",
    combinedDescription: `This listing is comprised of three townhome units within the Kaiulani of Princeville community, perched above beautiful Anini Beach on Kauai's North Shore. Together they offer 7 bedrooms and can accommodate up to 17 guests, with ocean and mountain views and access to the community pool.

Unit A is a spacious 3-bedroom, 2.5-bathroom two-story townhome (~1,800 sq ft) with high vaulted ceilings, a fully equipped kitchen, and a covered lanai with mountain and partial ocean views. Sleeps 8 with a King master upstairs, Queen and Twin bedrooms, and a queen sleeper sofa.

Unit B is two adjacent 2-bedroom townhomes combined to create a 4-bedroom, 3-bathroom vacation home (~2,400 sq ft). Each section has its own kitchen, living area, lanai, and queen sleeper sofa, providing flexibility for your group. Four bedrooms with King and Queen beds throughout. Sleeps 9.

Anini Beach below offers some of the calmest, clearest waters on Kauai, ideal for swimming, snorkeling, and kayaking. Princeville puts you at the gateway to Kauai's North Shore, with Hanalei Bay, the Na Pali Coast, and countless waterfalls all within reach. Nearby: Queen's Bath tide pools, Princeville Makai Golf Course, Na Pali Coast boat tours, Kilauea Lighthouse, taro fields of Hanalei Valley. Fine dining at Makana Terrace, casual eats in Hanalei town.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Kaiulani of Princeville places you at the gateway to Kauai's spectacular North Shore. Hanalei Bay, with its sweeping crescent beach and mountain backdrop, is 10 minutes west. Hanalei Town offers charming surf shops, farm-to-table cafes, and the iconic Hanalei Pier. Tunnels Beach and Haena State Park (Kalalau Trail trailhead) are 20 minutes further. Anini Beach — popular for windsurfing and calm swimming — and the Princeville Makai Golf Course are minutes away.",
    transit: "A rental car is essential for the North Shore. Lihue Airport is approximately 45 minutes south. Hanalei Town is a 10-minute drive west. One-lane bridges along the North Shore road are part of the charm — allow extra time. The road ends at Haena State Park (advance parking reservations required). Rideshare is available but infrequent on the North Shore.",
        taxMapKey: "450030040001",
    tatLicense: "TA-026-840-8901-01",
    getLicense: "GE-026-840-8901-01",
    strPermit: "TVR-2021-065",
    hasPhotos: true,
    communityPhotos: COMMUNITY_KAIULANI,
    communityPhotoFolder: "community-kaiulani",
    units: [
      {
        id: "prop29-kai-3br",
        unitNumber: "Unit 5",
        bedrooms: 3,
        bathrooms: "2.5",
        sqft: "~1,800",
        maxGuests: 8,
        shortDescription: "Ocean view 3BR/2.5BA two-story townhome above Anini Beach. Open living with high ceilings, full kitchen, covered lanai, and mountain views. King master upstairs, queen and twin bedrooms, and queen sleeper sofa. Pool access.",
        longDescription: `Welcome to this spacious 3-bedroom, 2.5-bathroom two-story townhome perched above beautiful Anini Beach on Kauai's North Shore.

High vaulted ceilings and an open floor plan create an impressive sense of space in the main living area. The fully equipped kitchen, dining area, and comfortable living room flow together, with sliding glass doors opening to a covered lanai with mountain and partial ocean views.

The upstairs king-bedded master suite features an en-suite bathroom and views of the surrounding greenery. The second bedroom offers a queen bed, and the third bedroom has twin beds. A queen sleeper sofa in the living area provides additional sleeping for two more guests. A half bath on the main level serves common areas. Ceiling fans and trade winds keep the home comfortable.

This townhome community features a shared pool and tropical landscaped grounds. The quiet residential setting offers privacy and peace while being conveniently located in Princeville.

Anini Beach, one of Kauai's most beautiful and protected beaches, is just down the hill - perfect for swimming, snorkeling, and windsurfing. The North Shore's legendary attractions including Hanalei Bay, Na Pali Coast, and the Kilauea Lighthouse are all easily accessible. Nearby you'll find Queen's Bath tide pools, Princeville Makai Golf Course, Na Pali Coast boat tours, and the taro fields of Hanalei Valley. Fine dining at Makana Terrace and casual eats in Hanalei town.`,
        photoFolder: "kaiulani-52",
        photos: PHOTOS_KAIULANI,
      },
      {
        id: "prop29-kai-4br",
        unitNumber: "Units 6-7",
        bedrooms: 4,
        bathrooms: "3",
        sqft: "~2,400",
        maxGuests: 9,
        shortDescription: "Two adjacent 2BR townhomes combined for 4 bedrooms and 3 baths. Each unit has its own kitchen, living area, lanai, and queen sleeper sofa. King and queen beds throughout. Ocean and mountain views above Anini Beach.",
        longDescription: `Welcome to this spacious 4-bedroom, 3-bathroom vacation home above Anini Beach, created from two adjacent 2-bedroom townhomes within the Kaiulani of Princeville community.

Each townhome unit has its own fully equipped kitchen, living area, and covered lanai, providing flexibility for your group. The combined layout creates a large vacation home while allowing different parts of your group to have their own space and privacy.

Four bedrooms across the two units feature king and queen beds. Three full bathrooms ensure comfort for all guests. Each townhome includes a queen sleeper sofa in the living area, providing additional sleeping for more guests. Each kitchen is fully stocked with modern appliances, cookware, and dining essentials.

The covered lanais offer views of the mountains and ocean, perfect for relaxing with a tropical drink. Trade winds and ceiling fans provide natural cooling.

Kaiulani's shared pool and landscaped grounds create a peaceful retreat. Anini Beach below offers some of the calmest, clearest waters on Kauai - ideal for swimming, snorkeling, and kayaking.

Princeville puts you at the gateway to Kauai's North Shore, with Hanalei Bay, the Na Pali Coast, and countless waterfalls all within reach for unforgettable day trips. Nearby you'll find Queen's Bath tide pools, Princeville Makai Golf Course, Na Pali Coast boat tours, Kilauea Lighthouse, and the taro fields of Hanalei Valley. Fine dining at Makana Terrace and casual eats in Hanalei town.`,
        photoFolder: "kaiulani-52",
        photos: PHOTOS_KAIULANI,
      },
    ],
  },
  {
    propertyId: 31,
    propertyName: "Fabulous 7 bedroom for 14 oceanfront Poipu pool home!",
    complexName: "Poipu Brenneckes Oceanfront",
    address: "2350 Ho'one Rd, Koloa, HI 96756",
    bookingTitle: "Poipu - 7BR Oceanfront Home - Sleeps 14",
    sampleDisclaimer: "This listing represents a managed oceanfront estate property. Photos are representative and individual decor and furnishings may vary. Your specific accommodation will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards.",
    combinedDescription: `This listing includes a stunning oceanfront pool home and a separate guest suite, both located on the same estate property steps from Brennecke's Beach on Kauai's premier Poipu coast. Together they offer 7 bedrooms and can accommodate up to 14 guests, with ocean views, a private pool, and an unbeatable beachside location.

The Main Home is a spacious 5-bedroom, 3-bathroom oceanfront pool home (~3,000 sq ft) with an open layout designed to maximize ocean views, a gourmet kitchen with granite counters, and a private pool surrounded by tropical landscaping. Sleeps 10 with a King master suite, Queen-bedded rooms, Twin room, and a queen sleeper sofa. AC throughout.

The Guest Suite is a separate living space (~800 sq ft) adjacent to the main home with its own entrance, offering 2 bedrooms with Queen beds, a private bathroom, and full access to the main home's pool and outdoor amenities. Sleeps 4.

Walk to Brennecke's Beach, Poipu Beach Park, or Shipwreck Beach in minutes. This is one of Poipu's most coveted oceanfront locations. Nearby: Poipu Shopping Village, Kukui'ula Village (dining/shops), Spouting Horn blowhole, National Tropical Botanical Garden, Koloa Town historic district. Snorkeling at Poipu Beach with sea turtles and monk seals. Great restaurants including The Beach House, Merriman's, and Tidepools.

Important: This listing represents our managed portfolio of similar properties. Your specific accommodation will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual decor and furnishings may vary.`,
    neighborhood: "This oceanfront Poipu location puts you steps from Brenneckes Beach — one of Kauai's top bodyboarding spots — and within walking distance of Poipu Beach Park with its sea turtles, excellent snorkeling, and sheltered family swimming. Poipu is consistently the sunniest area on Kauai. Koloa Town and its historic plantation village are 5 minutes away for restaurants and shopping. Spouting Horn blowhole, the National Tropical Botanical Garden, and the Grand Hyatt Kauai are all nearby.",
    transit: "A rental car is recommended on the South Shore. Lihue Airport is approximately 30 minutes away. Koloa Town is 5 minutes by car. Waimea Canyon is 45 minutes west, and the North Shore is about an hour. Rideshare (Lyft) is available and the Kauai Bus serves the area on limited routes.",
        taxMapKey: "420170030002",
    tatLicense: "TA-023-910-6789-02",
    getLicense: "GE-023-910-6789-02",
    strPermit: "TVR-2023-062",
    hasPhotos: true,
    communityPhotos: COMMUNITY_POIPU_OCEANFRONT,
    communityPhotoFolder: "community-poipu-oceanfront",
    units: [
      {
        id: "prop31-main",
        unitNumber: "Main Home",
        bedrooms: 5,
        bathrooms: "3",
        sqft: "~3,000",
        maxGuests: 10,
        shortDescription: "Oceanfront 5-bedroom, 3-bath pool home steps from Brennecke's Beach. Open layout with ocean views, gourmet kitchen, private pool, covered lanai, and tropical gardens. King master, queens, twins, and queen sleeper sofa.",
        longDescription: `Welcome to this stunning oceanfront 5-bedroom, 3-bathroom pool home located steps from Brennecke's Beach on Kauai's premier Poipu coast.

This spacious home features an open layout designed to take full advantage of the spectacular ocean views. The living room, dining area, and gourmet kitchen flow together with large windows and glass doors opening to the covered lanai and pool deck.

The gourmet kitchen is equipped with high-end appliances, granite counters, and ample space for preparing meals for your group. The dining area seats the whole party comfortably.

Five bedrooms include a king-bedded master suite with ocean-view en-suite bathroom, queen-bedded rooms, and a twin-bedded room perfect for younger guests. A queen sleeper sofa in the living area provides additional sleeping for two more guests. Three full bathrooms ensure comfort for all. AC throughout and ceiling fans provide cooling options.

The private pool is the centerpiece of the outdoor living space, surrounded by tropical landscaping and ocean views. The covered lanai offers al fresco dining, lounging, and sunset watching. Beach chairs, towels, and snorkel gear are provided.

Walk to Brennecke's Beach, Poipu Beach Park, or Shipwreck Beach in minutes. This is one of Poipu's most coveted oceanfront locations. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Snorkeling with sea turtles and monk seals. Great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "poipu-oceanfront",
        photos: PHOTOS_POIPU_OCEANFRONT,
      },
      {
        id: "prop31-guest",
        unitNumber: "Guest Suite",
        bedrooms: 2,
        bathrooms: "1",
        sqft: "~800",
        maxGuests: 4,
        shortDescription: "Separate guest suite adjacent to the main home with 2 bedrooms, private bathroom, and its own entrance. Shares pool and outdoor amenities. Queen beds in both rooms.",
        longDescription: `The Guest Suite at this Poipu oceanfront estate provides a separate living space with its own entrance, offering privacy while being just steps from the main home and its full amenities.

Two comfortable bedrooms each feature queen beds, and a private bathroom serves the suite exclusively. The separate entrance provides independence for guests who appreciate their own space.

Full access to the main home's gourmet kitchen, living areas, private pool, and outdoor amenities is included. The poolside location means you can step right out to the pool deck.

The unbeatable Poipu location puts Brennecke's Beach, Poipu Beach Park, and Shipwreck Beach all within walking distance. Enjoy Kauai's sunniest coast with its world-class snorkeling, dining, and dramatic coastal scenery. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "poipu-oceanfront",
        photos: PHOTOS_POIPU_OCEANFRONT,
      },
    ],
  },
  {
    propertyId: 32,
    propertyName: "Gorgeous Poipu Townhomes for 12 with AC! 5 Bedrooms.",
    complexName: "Pili Mai",
    address: "2253 Poipu Rd, Unit A, Koloa, HI 96756",
    bookingTitle: "Pili Mai - 5BR Townhomes - Sleeps 12",
    sampleDisclaimer: "This listing represents a managed portfolio of similar units within Pili Mai at Poipu. The specific unit assigned will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards. Photos are representative and individual unit decor and furnishings may vary.",
    combinedDescription: `This listing is comprised of two townhomes within Pili Mai at Poipu, a premier resort community in the heart of Poipu. Together they offer 5 bedrooms and can accommodate up to 14 guests, with AC throughout and easy access to Poipu Beach.

Unit A is a 3-bedroom, 3-bathroom townhome (~1,500 sq ft) with AC, a tropical garden setting, a full kitchen, and private bathrooms for each bedroom. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa.

Unit B is a garden view 2-bedroom, 2-bathroom townhome (~1,100 sq ft) with AC, a full kitchen, and a lanai overlooking the tropical gardens. Sleeps 6 with a King master, Queen second bedroom, and a queen sleeper sofa.

Walk to Poipu Beach, consistently rated one of Hawaii's best. Nearby: Poipu Shopping Village, Kukui'ula Village (dining/shops), Spouting Horn blowhole, National Tropical Botanical Garden, Koloa Town historic district. Snorkeling at Poipu Beach with sea turtles and monk seals. Great restaurants including The Beach House, Merriman's, and Tidepools. Scenic Maha'ulepu Heritage Trail along the coast.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Pili Mai is a newer luxury resort community in Poipu, Kauai's premier South Shore destination. Poipu Beach Park, Brenneckes Beach, and Shipwreck Beach are all within a short drive. The Grand Hyatt Kauai Resort and its restaurants, pools, and spa are nearby. Koloa Town — Kauai's oldest plantation village — is 5 minutes away with boutique shops, local restaurants, and the Koloa Heritage Trail. Spouting Horn blowhole and the National Tropical Botanical Garden are also close.",
    transit: "A rental car is recommended. Lihue Airport is approximately 25-30 minutes away. Koloa Town is 5 minutes by car. Waimea Canyon is about 45 minutes west. The North Shore is about an hour's drive. Rideshare (Lyft) is available and the Kauai Bus provides limited public transport on the South Shore.",
        taxMapKey: "420140050001",
    tatLicense: "TA-024-120-9012-01",
    getLicense: "GE-024-120-9012-01",
    strPermit: "TVR-2022-037",
    hasPhotos: true,
    communityPhotos: COMMUNITY_PILI_MAI,
    communityPhotoFolder: "community-pili-mai",
    units: [
      {
        id: "prop32-kia-3br",
        unitNumber: "Building 38",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,500",
        maxGuests: 8,
        shortDescription: "3BR/3BA townhome at Pili Mai at Poipu with AC, tropical garden setting, full kitchen, and steps to Poipu Beach. King master, queen, and twin bedrooms plus queen sleeper sofa. Access to resort pool and grounds.",
        longDescription: `Welcome to this 3-bedroom, 3-bathroom townhome at Pili Mai at Poipu, a premier resort community in the heart of Poipu.

This spacious townhome offers modern comfort with air conditioning throughout, complemented by ceiling fans and tropical breezes. The tropical garden setting creates a relaxing atmosphere.

The king-bedded master suite features a private en-suite bathroom. The second bedroom has a queen bed, and the third offers twin beds - each with its own bathroom. A queen sleeper sofa in the living area provides additional sleeping for two more guests. The fully equipped kitchen, comfortable living area, and dining space create a welcoming home base.

The resort grounds feature manicured gardens, meandering paths, and the resort pool. Walk to Poipu Beach, consistently rated one of Hawaii's best.

The on-site restaurant, nearby shops, and Poipu's dining scene are all convenient. Explore Spouting Horn, the National Tropical Botanical Garden, or the dramatic coastline of Maha'ulepu Heritage Trail. Walk to Poipu Beach for snorkeling with sea turtles and monk seals. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, and the historic Koloa Town district. Great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "pili-mai-unit-a",
        photos: PHOTOS_PILI_MAI_UNIT_A,
      },
      {
        id: "prop32-kia-2br",
        unitNumber: "Building 2",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,100",
        maxGuests: 6,
        shortDescription: "Garden view 2BR/2BA townhome at Pili Mai at Poipu. AC, full kitchen, lanai, and easy access to Poipu Beach. King master and queen second bedroom plus queen sleeper sofa. Resort pool and tropical garden paths.",
        longDescription: `Welcome to this 2-bedroom, 2-bathroom townhome at Pili Mai at Poipu, set among beautiful tropical gardens.

This comfortable unit features air conditioning, a full kitchen with modern appliances, and a cozy living area that opens to a lanai overlooking the tropical gardens. The king-bedded master suite has a private en-suite bath, and the queen-bedded second bedroom is adjacent to the second full bath. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

All linens, beach towels, WiFi, and basic kitchen supplies are provided. The resort pool and garden walking paths offer relaxation between beach adventures.

Walk to Poipu Beach for swimming, snorkeling, and sunbathing. Poipu's location on Kauai's south shore guarantees the island's best weather and most consistent sunshine.

Nearby attractions include Spouting Horn blowhole, Allerton Garden, and the scenic Maha'ulepu coastal trail. Walk to Poipu Beach for snorkeling with sea turtles and monk seals. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, and the historic Koloa Town district. Great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "pili-mai-unit-b",
        photos: PHOTOS_PILI_MAI_UNIT_B,
      },
    ],
  },
  {
    propertyId: 33,
    propertyName: "Beautiful Poipu Townhomes for 12 with AC! 6 Bedrooms.",
    complexName: "Pili Mai",
    address: "2253 Poipu Rd, Unit B, Koloa, HI 96756",
    bookingTitle: "Pili Mai - 6BR Townhomes - Sleeps 12",
    sampleDisclaimer: "This listing represents a managed portfolio of similar units within Pili Mai at Poipu. The specific unit assigned will be confirmed prior to check-in and will match the advertised bedroom count and amenity standards. Photos are representative and individual unit decor and furnishings may vary.",
    combinedDescription: `This listing is comprised of two spacious 3-bedroom townhomes within Pili Mai at Poipu, a premier resort community in the heart of Poipu. Together they offer 6 bedrooms and can accommodate up to 16 guests, with AC throughout and easy access to Poipu Beach.

Unit A is a tropical 3-bedroom, 3-bathroom townhome (~1,500 sq ft) with AC, a full kitchen, covered lanai with garden views, and private bathrooms for each bedroom. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa.

Unit B is a stylish 3-bedroom, 3-bathroom townhome (~1,500 sq ft) with a modern aesthetic, AC throughout, a quality kitchen, and a lanai overlooking the resort's spectacular gardens. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa.

Walk to Poipu Beach from the resort. Nearby: Poipu Shopping Village, Kukui'ula Village (dining/shops), Spouting Horn blowhole, National Tropical Botanical Garden, Koloa Town historic district. Snorkeling at Poipu Beach with sea turtles and monk seals. Great restaurants including The Beach House, Merriman's, and Tidepools. Outstanding snorkeling at Koloa Landing.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Pili Mai is a newer luxury resort community in Poipu, Kauai's premier South Shore destination. Poipu Beach Park, Brenneckes Beach, and Shipwreck Beach are all within a short drive. The Grand Hyatt Kauai Resort and its restaurants, pools, and spa are nearby. Koloa Town — Kauai's oldest plantation village — is 5 minutes away with boutique shops, local restaurants, and the Koloa Heritage Trail. Spouting Horn blowhole and the National Tropical Botanical Garden are also close.",
    transit: "A rental car is recommended. Lihue Airport is approximately 25-30 minutes away. Koloa Town is 5 minutes by car. Waimea Canyon is about 45 minutes west. The North Shore is about an hour's drive. Rideshare (Lyft) is available and the Kauai Bus provides limited public transport on the South Shore.",
        taxMapKey: "420140050002",
    tatLicense: "TA-024-120-9012-02",
    getLicense: "GE-024-120-9012-02",
    strPermit: "TVR-2022-038",
    hasPhotos: true,
    communityPhotos: COMMUNITY_PILI_MAI,
    communityPhotoFolder: "community-pili-mai",
    units: [
      {
        id: "prop33-kia-3br-a",
        unitNumber: "Building 10",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,500",
        maxGuests: 8,
        shortDescription: "Tropical 3BR/3BA townhome at Pili Mai at Poipu with AC, full kitchen, lanai with garden views, and easy access to Poipu Beach. King master, queen and twin bedrooms plus queen sleeper sofa.",
        longDescription: `Welcome to this 3-bedroom, 3-bathroom townhome at Pili Mai at Poipu, a premier resort community in the heart of Poipu.

This well-appointed unit features AC throughout, an open floor plan with the living room flowing into the fully equipped kitchen and dining area. The covered lanai provides a peaceful outdoor space surrounded by tropical plants and the resort's beautiful grounds.

Three bedrooms each have their own bathroom: the king-bedded master suite, queen second bedroom, and twin-bedded third room. A queen sleeper sofa in the living area provides additional sleeping for two more guests. All rooms feature ceiling fans and AC for comfort.

The kitchen is fully stocked for home cooking, and the dining area accommodates the whole group. WiFi, cable TV, washer/dryer access, and all linens are provided.

Walk to Poipu Beach from the resort. The resort pool and beautifully maintained grounds make this an exceptional Kauai vacation base.

Explore the south shore's attractions including Spouting Horn, the National Tropical Botanical Garden, and outstanding snorkeling at nearby Koloa Landing.`,
        photoFolder: "pili-mai-unit-a",
        photos: PHOTOS_PILI_MAI_UNIT_A,
      },
      {
        id: "prop33-kia-3br-b",
        unitNumber: "Building 26",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,500",
        maxGuests: 8,
        shortDescription: "Stylish 3BR/3BA townhome at Pili Mai at Poipu. AC, modern kitchen, comfortable bedrooms with private baths, queen sleeper sofa, and lanai overlooking gardens. King, queen, and twin beds. Walk to Poipu Beach.",
        longDescription: `Welcome to this stylish 3-bedroom, 3-bathroom townhome at Pili Mai at Poipu, a premier resort community in the heart of Poipu.

Updated with a modern aesthetic, this townhome offers comfortable living with AC throughout. The open layout connects the living, dining, and kitchen areas for easy entertaining.

Each bedroom features its own private bathroom. The king-bedded master suite provides a private retreat, while the queen and twin-bedded rooms accommodate additional guests comfortably. A queen sleeper sofa in the living area provides additional sleeping for two more guests. Ceiling fans supplement the AC.

The modern kitchen has quality appliances, ample counter space, and all the essentials for preparing meals. The lanai overlooks the resort's spectacular gardens.

Walk to Poipu Beach from the resort. The tropical gardens and beautifully maintained grounds create a serene environment.

Poipu's south shore offers year-round sunshine, world-class snorkeling, and the best dining and shopping on Kauai's south coast. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "pili-mai-unit-b",
        photos: PHOTOS_PILI_MAI_UNIT_B,
      },
    ],
  },
  {
    propertyId: 27,
    propertyName: "Beautiful 4 bedroom Poipu Kai Condo!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Koloa, HI 96756",
    bookingTitle: "Poipu Kai - 4BR Condos, Pool - Sleeps 8",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of two 2-bedroom condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 4 bedrooms and can accommodate up to 8 guests, an ideal setup for families or friends traveling together on Kauai's sunny south shore.

Unit A is a stylish 2-bedroom, 2-bathroom ground-floor condo (~1,200 sq ft) with central AC, a renovated kitchen with granite counters, and a private garden lanai. Sleeps 4 with a King master and Queen second bedroom, plus a queen sleeper sofa for 2 additional guests.

Unit B is a bright 2-bedroom, 2-bathroom condo (~1,250 sq ft) with central AC, modern stainless steel kitchen, and a private lanai with garden views. Sleeps 4 with King beds in both bedrooms, plus a queen sleeper sofa for 2 additional guests.

All guests enjoy resort amenities including a swimming pool, hot tub, tennis and pickleball courts, and tropical garden paths. Shipwreck Beach, Brennecke's Beach, and Poipu Beach Park are all within a pleasant 10-minute walk. Nearby: Poipu Shopping Village, Kukui'ula Village (dining/shops), Spouting Horn blowhole, National Tropical Botanical Garden, Koloa Town historic district. Snorkeling at Poipu Beach, sea turtles, monk seals. Great restaurants including The Beach House, Merriman's, Tidepools.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`,
    neighborhood: "Regency at Poipu Kai is tucked into Poipu, Kauai's sunniest and most popular resort area. Poipu Beach Park — consistently ranked one of America's best beaches — is a short drive away, with excellent snorkeling, sea turtle sightings, and a sheltered swimming area. Brenneckes Beach and Shipwreck Beach are nearby for bodyboarding and bodysurfing. Koloa Town, Kauai's oldest plantation village, is 5 minutes away with boutique shops, restaurants, and the Koloa Heritage Trail. Spouting Horn blowhole, the National Tropical Botanical Garden, and Moir Gardens round out the area's attractions.",
    transit: "A rental car is strongly recommended for exploring Kauai. Lihue Airport is approximately 25-30 minutes away. Koloa Town is 5 minutes by car. Waimea Canyon (Grand Canyon of the Pacific) is about 45 minutes west, and the North Shore is about an hour. Rideshare (Lyft) is available on Kauai but limited in frequency. The Kauai Bus provides budget public transport along main routes.",
        taxMapKey: "420150010003",
    tatLicense: "TA-023-450-1234-08",
    getLicense: "GE-023-450-1234-08",
    strPermit: "TVR-2022-044",
    hasPhotos: true,
    communityPhotos: COMMUNITY_REGENCY,
    communityPhotoFolder: "community-regency-poipu-kai",
    units: [
      {
        id: "prop27-unit-a",
        unitNumber: "A",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,200",
        maxGuests: 6,
        shortDescription: "Stylish ground-floor 2-bedroom, 2-bath Regency condo with central AC, renovated granite kitchen, garden lanai, King master and Queen second bedroom, plus queen sleeper sofa. Steps to pool, tennis courts, and three Poipu beaches.",
        longDescription: `Welcome to this stylishly renovated 2-bedroom, 2-bathroom ground-floor condominium at the Regency at Poipu Kai resort on Kauai's coveted south shore.

This approximately 1,200 sq ft retreat features central air conditioning and a bright, inviting interior with updated finishes throughout. The open-concept living and dining area flows seamlessly to a private garden lanai, perfect for morning coffee or evening relaxation.

The renovated kitchen boasts granite countertops, modern appliances, and plenty of prep space for cooking vacation meals. A breakfast bar adds casual seating.

The king-bedded master suite includes an en-suite bathroom with contemporary fixtures. The second bedroom features a comfortable Queen bed with the second full bathroom adjacent. A queen sleeper sofa in the living area provides additional sleeping for two more guests. WiFi, cable TV, washer/dryer, and all linens are included.

The Regency at Poipu Kai resort amenities are steps from your door: a sparkling pool, hot tub, and tennis and pickleball courts set among beautifully landscaped tropical gardens.

Three of Poipu's best beaches are within a 10-minute walk. Discover vibrant coral reefs at Poipu Beach Park, bodysurf the waves at Brennecke's Beach, or enjoy dramatic coastal views from Shipwreck Beach. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Watch for sea turtles and monk seals at the beach, and enjoy great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "unit-114",
        photos: PHOTOS_114,
      },
      {
        id: "prop27-unit-b",
        unitNumber: "B",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,250",
        maxGuests: 6,
        shortDescription: "Modern 2-bedroom, 2-bath Regency condo with central AC, stainless steel kitchen, garden lanai, King beds in both rooms, plus queen sleeper sofa. Steps to pool, tennis courts, and three Poipu beaches.",
        longDescription: `Welcome to this sleek and modern 2-bedroom, 2-bathroom condominium at the Regency at Poipu Kai resort. This unit features central air conditioning and tasteful contemporary updates throughout.

The approximately 1,250 sq ft layout is efficiently designed with an open living area that connects to the kitchen and dining space. A private lanai offers a quiet retreat with views of the tropical gardens.

The updated kitchen features stainless steel appliances, modern finishes, and is fully stocked for meal preparation. The dining area provides ample seating for your group.

Both bedrooms feature plush King beds for maximum sleeping comfort. The master bedroom includes an en-suite bathroom, while the second bedroom is adjacent to the second full bath. A queen sleeper sofa in the living area provides additional sleeping for two more guests. WiFi, cable TV, washer/dryer, and all linens are included.

Resort amenities including the swimming pool, hot tub, and tennis and pickleball courts are just a short walk from your door. The tropical gardens and well-maintained grounds create a peaceful resort atmosphere.

Kauai's famous south shore beaches are a leisurely 10-minute walk from the complex. Enjoy world-class snorkeling at Poipu Beach Park, exciting body surfing at Brennecke's Beach, or peaceful sunset views from Shipwreck Beach. Nearby you'll find Poipu Shopping Village, Kukui'ula Village for dining and shops, Spouting Horn blowhole, the National Tropical Botanical Garden, and the historic Koloa Town district. Watch for sea turtles and monk seals at the beach, and enjoy great restaurants including The Beach House, Merriman's, and Tidepools.`,
        photoFolder: "unit-911",
        photos: PHOTOS_911,
      },
    ],
  },
];

export function getUnitBuilderByPropertyId(propertyId: number): PropertyUnitBuilder | undefined {
  return unitBuilderData.find((p) => p.propertyId === propertyId);
}

export function getMultiUnitPropertyIds(): number[] {
  return unitBuilderData.map((p) => p.propertyId);
}

export function getAllMultiUnitProperties(): { propertyId: number; propertyName: string; complexName: string }[] {
  return unitBuilderData.map((p) => ({
    propertyId: p.propertyId,
    propertyName: p.propertyName,
    complexName: p.complexName,
  }));
}
