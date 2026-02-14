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

export type PropertyUnitBuilder = {
  propertyId: number;
  propertyName: string;
  complexName: string;
  address: string;
  bookingTitle: string;
  sampleDisclaimer: string;
  combinedDescription: string;
  units: Unit[];
  hasPhotos: boolean;
};

const DEFAULT_DISCLAIMER = "Photos shown are representative samples of units within this complex. Individual units may vary in decor, furnishings, and layout. Actual unit assigned will be of comparable quality and configuration.";

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
  { filename: "photo_6.jpg", label: "Pool Area", category: "Exterior" },
  { filename: "photo_7.jpg", label: "Lanai Dining", category: "Exterior" },
  { filename: "photo_8.jpg", label: "Guest Suite", category: "Bedrooms" },
  { filename: "photo_9.jpg", label: "Kitchen Island", category: "Kitchen" },
  { filename: "photo_10.jpg", label: "Master Bathroom", category: "Bathrooms" },
  { filename: "photo_11.jpg", label: "Ocean View from Lanai", category: "Exterior" },
  { filename: "photo_12.jpg", label: "Tropical Gardens", category: "Exterior" },
  { filename: "photo_13.jpg", label: "Guest Bathroom", category: "Bathrooms" },
  { filename: "photo_14.jpg", label: "Bedroom 3", category: "Bedrooms" },
  { filename: "photo_15.jpg", label: "Bedroom 4", category: "Bedrooms" },
  { filename: "photo_16.jpg", label: "Estate Exterior", category: "Exterior" },
  { filename: "photo_17.jpg", label: "Casita Guest Quarters", category: "Bedrooms" },
  { filename: "photo_18.jpg", label: "Sunset View", category: "Exterior" },
];

export const unitBuilderData: PropertyUnitBuilder[] = [
  {
    propertyId: 1,
    propertyName: "Poipu Kai for large groups!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Bldg 8, Koloa, HI 96756",
    bookingTitle: "Regency at Poipu Kai - Sleeps 16 | 7BR Resort Villas with Pool & Tennis | Poipu Beach, Kauai",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of three spacious condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 7 bedrooms and can accommodate up to 19 guests, making this an ideal setup for large family reunions or group vacations on Kauai's sunny south shore.

Unit 924 is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) featuring a King bed in the master suite with jetted tub and walk-in marble shower, a Queen bed in the second bedroom, 2 Twins in the loft third bedroom, and a futon for additional sleeping. Central AC and an open-concept layout with granite kitchen make this a comfortable home base.

Unit 114 is a 2-bedroom, 2-bathroom ground-floor condo (~1,250 sq ft) with a modern renovation, Queen bed in the primary bedroom, King bed in the second bedroom, and a queen sleeper sofa. Two private balconies, stainless steel kitchen, and AC with ceiling fans throughout.

Unit 911 is a 2-bedroom, 2-bathroom condo (~1,250 sq ft) with central AC, King beds in both bedrooms, a queen sleeper sofa, smart TVs, and a private covered lanai. The fully stocked kitchen and large dining area are perfect for group meals.

All guests enjoy resort amenities including a sparkling pool, hot tub, tennis and pickleball courts, and tropical garden paths. Shipwreck Beach, Brennecke's Beach, and Poipu Beach Park are all within an easy 10-minute walk.`,
    hasPhotos: true,
    units: [
      {
        id: "unit-924",
        unitNumber: "924",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Elegant 3-bedroom, 3-bath Regency II condo on the 2nd floor of building 9. Features Hawaiian-style furniture, granite kitchen, central AC, jetted tub in the master bath, and a walk-in marble shower. Sleeps 7 with King, Queen, 2 Twins, and a futon in the loft.",
        longDescription: `Welcome to Unit 924, a beautifully furnished 3-bedroom, 3-bathroom condominium on the second floor of Building 9 at the Regency at Poipu Kai resort. This spacious approximately 1,800 sq ft home away from home features central air conditioning throughout and an inviting Hawaiian-style interior.

The open-concept living area flows from comfortable seating through a generous dining space to the fully equipped granite kitchen. A private lanai overlooks lush tropical gardens, perfect for morning coffee or evening relaxation. The great room design ensures everyone stays connected.

The gourmet kitchen features granite countertops, modern appliances, and everything you need to prepare meals for your group. A washer and dryer are conveniently located in the unit, along with beach chairs, towels, and coolers for your beach adventures.

The master bedroom offers a plush King bed and en-suite bathroom with a luxurious jetted tub and walk-in marble shower. The second bedroom features a comfortable Queen bed, while the third bedroom has 2 Twin beds. An upstairs loft with futon provides additional sleeping space.

Enjoy resort amenities including a sparkling swimming pool, hot tub, tennis and pickleball courts, and strolls through manicured tropical gardens. Shipwreck Beach, Brennecke's Beach, and Poipu Beach Park are all within a 10-minute walk.

Poipu's sunny south shore offers world-class snorkeling, surfing, and dining. From exploring the nearby National Tropical Botanical Garden to watching for sea turtles at the beach, this condo is your perfect Kauai home base.`,
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
        shortDescription: "Modern 2-bedroom, 2-bath ground-floor condo in Regency I building 1. Features AC and ceiling fans, a renovated modern kitchen with stainless appliances, two private balconies, and an open floor plan. Sleeps 6 with Queen and King beds and a queen sleeper sofa.",
        longDescription: `Welcome to Unit 114, a stylishly renovated 2-bedroom, 2-bathroom ground-floor condominium in Building 1 of the Regency at Poipu Kai resort on Kauai's coveted south shore.

This approximately 1,250 sq ft condo has been thoughtfully updated with a modern aesthetic while maintaining its warm island charm. The open floor plan creates a spacious feel, with the living room flowing into the dining area and kitchen. Air conditioning and ceiling fans keep you comfortable year-round.

The modern kitchen features sleek stainless steel appliances, ample counter space, and is fully stocked with everything you need for home-cooked meals. Two private balconies provide outdoor living space to enjoy the tropical breezes and garden views.

The primary bedroom features a comfortable Queen bed with its own renovated en-suite bathroom with dual sinks. The second bedroom offers a King bed and is adjacent to the second full bathroom, also beautifully renovated. A queen sleeper sofa in the living area provides additional sleeping for two more guests. A convenient work area is available for those who need to stay connected.

As a Regency at Poipu Kai guest, you have full access to the resort pool, hot tub, tennis and pickleball courts, and lush tropical garden paths. Three world-class Poipu beaches are just a short 10-minute walk away.

From snorkeling at Poipu Beach Park to body surfing at Brennecke's Beach, or watching the sunset from Shipwreck Beach, this condo puts you in the heart of Kauai's best coastal experiences.`,
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
        shortDescription: "Comfortable 2-bedroom, 2-bath Regency II condo in building 9 with central AC throughout. Features King beds in both rooms, a fully stocked kitchen, large dining area, private covered lanai, and smart TVs. Sleeps 6 with two King beds and a queen sleeper sofa.",
        longDescription: `Welcome to Unit 911, a well-appointed 2-bedroom, 2-bathroom condominium in Building 9 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning throughout for your complete comfort on Kauai's sunny south shore.

The approximately 1,250 sq ft interior offers a thoughtfully designed layout with a spacious living area, large dining area that seats the whole party, and a private covered lanai perfect for al fresco dining or simply soaking in the tropical garden views. Smart TVs in the living area and bedrooms provide entertainment options.

The fully stocked kitchen includes modern appliances, generous counter space, and all the cookware and utensils needed for everything from quick breakfasts to full dinners. The open layout connects the kitchen to the dining and living spaces for easy socializing.

The master bedroom features a plush King bed, smart TV, and en-suite bathroom with a soaking tub and separate shower. The second bedroom also offers a comfortable King bed and is adjacent to the second full bathroom, ideal for couples traveling together. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

Resort amenities await just steps from your door, including a gorgeous swimming pool, relaxing hot tub, and tennis and pickleball courts surrounded by tropical gardens. Shipwreck Beach, Brennecke's Beach, and Poipu Beach Park are all an easy 10-minute stroll.

Whether you spend your days exploring Waimea Canyon, snorkeling with sea turtles, or relaxing poolside, this condo offers a perfect retreat on the Garden Isle.`,
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
    bookingTitle: "Regency at Poipu Kai - Sleeps 16 | 6BR Villas with Pool & Tennis | Poipu, Kauai",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of two spacious 3-bedroom condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 6 bedrooms and can accommodate up to 16 guests, perfect for large groups exploring Kauai's sunny south shore.

Unit 423 is a 3-bedroom, 2.5-bathroom condo (~1,800 sq ft) with a covered dining lanai, open great room layout, fully equipped kitchen with breakfast bar, and a master suite with private lanai and en-suite bath. Sleeps 8 with a King bed, Queen bed, 2 Twins in the loft, and a queen sleeper sofa.

Unit 621 is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) featuring lovely garden views from the living room and lanai, a primary bedroom suite with private lanai and walk-in shower, and two additional guest bedrooms each with their own bath. Sleeps 8 with a King bed, Queen bed, 2 Twins, and a queen sleeper sofa.

All guests enjoy resort amenities including a swimming pool, hot tub, tennis and pickleball courts, and beautifully maintained tropical gardens. Shipwreck Beach, Brennecke's Beach, and Poipu Beach Park are all within a pleasant 10-minute walk.`,
    hasPhotos: true,
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

The complex is ideally situated near shops, restaurants, and the Poipu Athletic Club. Whether you are looking to surf, snorkel, hike, or simply relax, this condo offers the perfect home base for your Kauai vacation.`,
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

Located on Kauai's sunny south shore, the area offers excellent dining, shopping, snorkeling, surfing, and hiking opportunities. This condo is perfectly positioned for experiencing the best of Kauai.`,
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
    bookingTitle: "Regency at Poipu Kai - Sleeps 22 | 8BR Resort Villas near Poipu Beach Park | Poipu, Kauai",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of three condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 8 bedrooms and can accommodate up to 21 guests, making this an exceptional option for large group gatherings on Kauai's beautiful south shore.

Unit 721 is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) with central AC, Hawaiian-style furnishings, a granite kitchen, and a spa-inspired master bath with jetted tub and walk-in marble shower. Sleeps 8 with a King bed, Queen bed, 2 Twins, and a queen sleeper sofa.

Unit 323 is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) featuring an expansive open floor plan, granite kitchen with breakfast bar, covered lanai, and AC in bedrooms. Sleeps 7 with a King bed, Queen bed, 2 Twins in the loft, and a sofa bed.

Unit 811 is a 2-bedroom, 2-bathroom ground-floor condo (~1,250 sq ft) with central AC throughout, King beds in both bedrooms, a queen sleeper sofa, and easy ground-level access to the pool and gardens. Sleeps 6.

All guests enjoy resort amenities including a sparkling pool, hot tub, tennis and pickleball courts, and tropical garden walkways. Poipu Beach Park, Brennecke's Beach, and Shipwreck Beach are all within a 10-minute walk.`,
    hasPhotos: true,
    units: [
      {
        id: "unit-721",
        unitNumber: "721",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 8,
        shortDescription: "Charming 3-bedroom, 3-bath Regency II condo in building 7 with Hawaiian-style furnishings, granite kitchen, and central AC. Features a jetted tub, walk-in marble shower, garden views, and a private balcony. Sleeps 8 with King, Queen, 2 Twin beds, and a queen sleeper sofa.",
        longDescription: `Welcome to Unit 721, a tastefully decorated 3-bedroom, 3-bathroom condominium in Building 7 of the Regency at Poipu Kai resort. This Regency II unit boasts central air conditioning and authentic Hawaiian-style furniture that captures the spirit of the islands.

The approximately 1,800 sq ft interior features a welcoming open layout with the living room flowing into a spacious dining area and well-appointed kitchen. Granite countertops, modern appliances, and ample prep space make cooking a pleasure. A private balcony offers serene garden views and fresh tropical air.

Step into the master suite to find a luxurious King bed and a spa-inspired en-suite bathroom featuring a jetted soaking tub and walk-in marble shower. The second bedroom provides a restful Queen bed, while the third bedroom is outfitted with 2 Twin beds, ideal for children or friends. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

An upper loft area provides a flexible bonus space for reading, relaxing, or extra sleeping arrangements. Each of the three full bathrooms is well-appointed, ensuring comfort and privacy for all guests.

Resort living is at its finest with a sparkling pool, soothing hot tub, and tennis and pickleball courts just steps away. Tropical garden walkways connect you to the heart of the Regency at Poipu Kai complex.

Poipu Beach Park, Brennecke's Beach, and Shipwreck Beach are all within a leisurely 10-minute walk. Enjoy snorkeling, surfing, tide pool exploration, and some of Kauai's best dining and shopping nearby.`,
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
        shortDescription: "Spacious 3-bedroom, 3-bath Regency I condo in building 3 with a generous open floor plan, granite kitchen, covered lanai, and a loft bedroom. AC available in bedrooms. Sleeps 7 with King, Queen, 2 Twins, and a sofa bed.",
        longDescription: `Welcome to Unit 323, a spacious 3-bedroom, 3-bathroom condominium in Building 3 of the Regency at Poipu Kai resort on Kauai's sunny south shore. This Regency I unit offers a generous layout with comfortable island-inspired decor.

The approximately 1,800 sq ft interior showcases an expansive open floor plan where the living room, dining area, and kitchen flow together seamlessly. The covered lanai extends your living space outdoors, providing a shaded retreat surrounded by tropical landscaping.

The granite kitchen is fully equipped with modern appliances, a breakfast bar for casual meals, and plenty of counter space for preparing feasts. The open design keeps the cook connected with everyone in the great room.

The master bedroom suite features a plush King bed with private lanai access and an en-suite bathroom. The second bedroom offers a comfortable Queen bed, and the third bedroom in the loft area has 2 Twin beds plus its own adjacent bath. A sofa bed in the living area provides additional sleeping for a 7th guest. Bedrooms are equipped with AC for restful nights.

As a Regency at Poipu Kai guest, you have access to the resort's swimming pool, hot tub, tennis and pickleball courts, and beautifully maintained tropical gardens. The complex is ideally located near shops and restaurants.

Three of Kauai's finest beaches are a short 10-minute walk away, including Poipu Beach Park for snorkeling and Shipwreck Beach for dramatic coastal scenery. Explore Waimea Canyon, take a boat tour of the Na Pali Coast, or simply relax in paradise.`,
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
        shortDescription: "Well-appointed 2-bedroom, 2-bath ground-floor Regency II condo in building 8 with central AC, King beds in both rooms, a full kitchen, garden views, and a private lanai. Sleeps 6 with two King beds and a queen sleeper sofa.",
        longDescription: `Welcome to Unit 811, a comfortable 2-bedroom, 2-bathroom ground-floor condominium in Building 8 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning throughout, ensuring cool comfort on even the warmest Kauai days.

The approximately 1,250 sq ft layout is thoughtfully designed with an open living and dining area that connects to the fully equipped kitchen. Sliding doors open to a private lanai with peaceful garden views, bringing the outside in. Smart TVs are available for entertainment.

The kitchen comes fully stocked with modern appliances, cookware, and utensils for preparing anything from tropical smoothies to multi-course dinners. A generous dining area provides space for the whole group to gather over meals.

Both bedrooms feature luxurious King beds for a restful night's sleep. The master bedroom has its own en-suite bathroom, while the second bedroom is adjacent to the second full bath. A queen sleeper sofa in the living area provides additional sleeping for two more guests. The ground-floor location provides easy access to the pool and gardens.

Resort amenities include a beautiful swimming pool and hot tub, tennis and pickleball courts, and winding paths through tropical gardens. Everything is just steps from your front door in this well-maintained complex.

Poipu's famous beaches are a pleasant 10-minute walk, where you can snorkel with tropical fish, body surf at Brennecke's Beach, or watch monk seals bask at Poipu Beach Park. The south shore's sunny weather makes every day a beach day.`,
        photoFolder: "unit-911",
        photos: PHOTOS_911,
      },
    ],
  },
  {
    propertyId: 8,
    propertyName: "Wonderful Large Group option in Poipu Kai!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Bldg 5, Koloa, HI 96756",
    bookingTitle: "Regency at Poipu Kai - Sleeps 16 | 6BR Group Villas with Pool & Tennis | Poipu, Kauai",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of two spacious 3-bedroom condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 6 bedrooms and can accommodate up to 14 guests, ideal for families or friends vacationing together on Kauai's sunny south shore.

Unit 623 is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) with central AC, a modern open-plan layout, granite countertops, and a covered lanai with garden views. Sleeps 7 with a King bed, Queen bed, 2 Twins, and a sofa bed.

Unit 624 is a 3-bedroom, 3-bathroom two-story condo (~1,800 sq ft) with full AC, a granite kitchen, wrap-around lanai, and a tropical garden setting. The two-story design provides natural separation for groups. Sleeps 7 with a King bed, Queen bed, 2 Twins, and a futon.

All guests enjoy resort amenities including a crystal-clear pool, hot tub, tennis and pickleball courts, and tropical garden paths. Three stunning Poipu beaches are just a 10-minute walk from your door.`,
    hasPhotos: true,
    units: [
      {
        id: "unit-623",
        unitNumber: "623",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Modern 3-bedroom, 3-bath Regency II condo in building 6 with central AC, open-plan living and dining, granite countertops, covered lanai with garden views, and comfortable furnishings. Sleeps 7 with King, Queen, 2 Twins, and a sofa bed.",
        longDescription: `Welcome to Unit 623, a beautifully maintained 3-bedroom, 3-bathroom condominium in Building 6 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning and a modern, inviting interior.

The approximately 1,800 sq ft open-plan layout creates an ideal space for groups, with the living room, dining area, and kitchen flowing together naturally. The covered lanai overlooks tranquil garden views and provides a lovely spot for outdoor dining or relaxation.

The kitchen is a chef's delight with granite countertops, modern stainless steel appliances, and generous storage. A breakfast bar adds casual seating, and the kitchen is fully equipped with everything needed for meal preparation.

The master bedroom features a King bed and en-suite bathroom with a spacious walk-in shower. The second bedroom offers a Queen bed, and the third bedroom has 2 Twin beds. A sofa bed in the living area provides sleeping for a 7th guest. All three full bathrooms are well-appointed.

Enjoy the Regency at Poipu Kai's resort amenities: a crystal-clear swimming pool, relaxing hot tub, and tennis and pickleball courts set amidst manicured tropical gardens. The complex offers a peaceful retreat with all the conveniences of home.

Three stunning beaches are just a 10-minute walk from your door. Snorkel at Poipu Beach Park, catch waves at Brennecke's Beach, or take a dramatic cliff walk at Shipwreck Beach. The sunny south shore of Kauai awaits your exploration.`,
        photoFolder: "unit-621",
        photos: PHOTOS_621,
      },
      {
        id: "unit-624",
        unitNumber: "624",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Inviting 3-bedroom, 3-bath two-story Regency II condo in building 6 with full AC, granite kitchen, wrap-around lanai, and a tropical garden setting. Features a loft bedroom and futon. Sleeps 7 with King, Queen, 2 Twins, and futon.",
        longDescription: `Welcome to Unit 624, a charming two-story 3-bedroom, 3-bathroom condominium in Building 6 of the Regency at Poipu Kai resort. This Regency II unit features full central air conditioning and is nestled in a lush tropical garden setting.

The approximately 1,800 sq ft interior spans two levels, creating a sense of spaciousness and privacy. The main level features an open living and dining area with a wrap-around lanai that brings the tropical outdoors inside. Natural light fills the space through generous windows.

The granite kitchen is fully equipped with modern appliances, ample counter space, and a breakfast bar. Whether you are making a quick smoothie or preparing a feast for the group, this kitchen has everything you need.

The master bedroom on the main level offers a King bed and a luxurious en-suite bathroom. The second bedroom features a Queen bed with its own bath. Upstairs, the loft-style third bedroom has 2 Twin beds plus a futon for additional sleeping, along with a third full bathroom. The two-story design provides natural separation for families and groups.

Step outside and enjoy the Regency at Poipu Kai amenities, including the resort pool and hot tub, tennis and pickleball courts, and meandering paths through tropical gardens.

From your home base in Poipu, explore Kauai's south shore treasures. Walk to Poipu Beach Park for world-class snorkeling, brave the waves at Brennecke's Beach, or discover the beauty of Shipwreck Beach's rugged coastline.`,
        photoFolder: "unit-924",
        photos: PHOTOS_924,
      },
    ],
  },
  {
    propertyId: 9,
    propertyName: "Spacious 5 Bedrooms in Poipu Kai! AC!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Bldg 6, Koloa, HI 96756",
    bookingTitle: "Regency at Poipu Kai - Sleeps 12 | 5BR AC Villas with Pool & Tennis | Poipu, Kauai",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of two condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 5 bedrooms and can accommodate up to 12 guests, a great option for families or groups looking for comfortable south shore accommodations with AC.

Unit 723 is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) with central AC, updated finishes, a granite kitchen, private balcony, and a loft bedroom. Sleeps 7 with a King bed, Queen bed, 2 Twins, and a sofa bed.

Unit 611 is a spacious corner 2-bedroom, 2-bathroom ground-floor condo (~1,400 sq ft) with central AC, extra natural light from the corner position, a Queen bed in the primary bedroom, and a King bed in the second bedroom. Sleeps 5.

All guests enjoy resort amenities including the swimming pool, hot tub, tennis and pickleball courts, and tropical garden paths. Poipu's beloved beaches are a short 10-minute walk from the resort.`,
    hasPhotos: true,
    units: [
      {
        id: "unit-723",
        unitNumber: "723",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Updated 3-bedroom, 3-bath Regency II condo in building 7 with central AC, granite kitchen, private balcony, loft bedroom, and garden views. Sleeps 7 with King, Queen, 2 Twins, and a sofa bed.",
        longDescription: `Welcome to Unit 723, a freshly updated 3-bedroom, 3-bathroom condominium in Building 7 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning and contemporary island-inspired interiors.

The approximately 1,800 sq ft home showcases updated finishes throughout, with a bright open floor plan that seamlessly connects the living room, dining area, and kitchen. A private balcony provides garden views and a quiet place to unwind with your morning coffee.

The full granite kitchen features modern appliances and generous counter space, making meal preparation a breeze. The open design keeps everyone together whether you are cooking, dining, or relaxing in the living area.

The master bedroom offers a King bed with en-suite bath, while the second bedroom features a Queen bed. The loft-level third bedroom has 2 Twin beds, and a sofa in the living area provides additional sleeping. Three full bathrooms ensure comfort and privacy for all guests.

Take advantage of the resort's sparkling pool, hot tub, and tennis and pickleball courts set among beautifully landscaped tropical gardens. The Regency at Poipu Kai complex provides a serene, resort-like atmosphere.

Kauai's famous south shore beaches are just a 10-minute walk away. Discover vibrant coral reefs at Poipu Beach Park, bodysurf the waves at Brennecke's Beach, or enjoy dramatic ocean views from Shipwreck Beach's coastal trail.`,
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
        shortDescription: "Corner ground-floor 2-bedroom, 2-bath Regency II condo in building 6 with central AC, Queen and King beds, a modern kitchen, and a garden lanai. This spacious 1,400 sq ft unit sleeps 5.",
        longDescription: `Welcome to Unit 611, a spacious corner ground-floor 2-bedroom, 2-bathroom condominium in Building 6 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning and an extra-generous 1,400 sq ft layout thanks to its corner position.

The bright, airy interior features a modern open floor plan with the living area opening to a private garden lanai. The corner location provides additional windows and natural light, creating an especially welcoming atmosphere.

The modern kitchen is fully equipped with updated appliances, plenty of counter space, and all the essentials for preparing meals during your stay. The dining area comfortably seats your group for family meals.

The primary bedroom features a comfortable Queen bed with an en-suite bathroom, while the second bedroom offers a King bed adjacent to the second full bath. Both bedrooms are equipped with AC for cool, restful nights.

Enjoy resort amenities including the swimming pool, hot tub, tennis and pickleball courts, and tropical garden paths. The ground-floor location makes accessing the pool and gardens effortless.

Poipu's beloved beaches are a short 10-minute walk from the resort. Swim and snorkel at Poipu Beach Park, ride the shore break at Brennecke's Beach, or explore the dramatic coastline at Shipwreck Beach. The south shore's reliable sunshine makes Poipu the perfect vacation destination.`,
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
    bookingTitle: "Kekaha Beachfront Estate - Sleeps 15 | 5BR Oceanfront Home & Cottage at Davidson's Surf Break | Kekaha, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of this beachfront estate. The main house and guest cottage may vary in decor and furnishings from photos shown.",
    combinedDescription: `This listing includes a luxury beachfront home and a charming guest cottage, both located on the same oceanfront estate property at Davidson's Surf Break in Kekaha on Kauai's sunny west side. Together they offer 5 bedrooms and can accommodate up to 15 guests, with direct beach access and spectacular Ni'ihau sunset views.

Kimsey Beach House is a 3-bedroom, 2-bathroom oceanfront home (~2,000 sq ft) with Merbau wood floors, travertine bathrooms, and granite countertops. Every room opens to the oceanfront patio. Sleeps 9 with a King bed, 3 Queen beds, a Twin bed in the sunroom, and a queen sleeper sofa. AC in the master and second bedrooms.

Kimsey Beach Cottage is a completely renovated 1930s plantation-style cottage (~1,200 sq ft) with 2 bedrooms and 3 bathrooms, located right next to the main house on the same property. Two king master suites each have en-suite baths, and a queen sleeper sofa provides additional sleeping. AC in both bedrooms. Sleeps 6.

Both homes share the same pristine beachfront property with miles of white sand beach, Weber BBQ, outdoor shower, and all beach amenities provided. Kekaha is the sunniest spot on Kauai, close to Waimea Canyon, Polihale Beach, and the Na Pali Coast.`,
    hasPhotos: true,
    units: [
      {
        id: "prop10-kimsey-house",
        unitNumber: "Kimsey Beach House",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~2,000",
        maxGuests: 9,
        shortDescription: "Luxury 3-bedroom, 2-bath oceanfront home at Davidson's Surf Break in Kekaha. Merbau wood floors, travertine bathrooms, granite countertops. Every room opens to the oceanfront patio, steps from the beach. AC in master and second bedrooms. Sleeps 9 with King, 3 Queens, Twin, and queen sleeper sofa.",
        longDescription: `Welcome to Kimsey Beach House, a luxury 3-bedroom, 2-bathroom oceanfront home located directly on Davidson's Surf Break in Kekaha on Kauai's sunny west side. This beautifully remodeled beach home puts you steps from miles of pristine white sand beach.

The home has been renovated with Merbau wood floors throughout, travertine bathrooms, and granite countertops. Every room features sliding glass doors that lead directly to the oceanfront patio and lanai, creating a seamless indoor-outdoor living experience with the sound of waves as your constant soundtrack.

The spacious great room flows from comfortable living areas through a generous dining space to the fully equipped modern kitchen, perfect for preparing family meals and entertaining. Two living areas provide plenty of space for your group to spread out.

The private master suite is separate from the other bedrooms for added privacy, featuring a King bed and an en-suite travertine bathroom with a double-head walk-in shower. The second bedroom has a Queen bed, and the third bedroom features two Queen beds. A sleeping sunroom with a twin bed and a queen sleeper sofa in the living area provide additional sleeping space. Split AC units cool the master and second bedrooms.

Enjoy spectacular Ni'ihau sunset views from the oceanfront patio. A Weber BBQ, outdoor shower, and full laundry room are included. Beach towels, beach chairs, and all linens provided.

Kekaha is the sunniest spot on Kauai with a laid-back local vibe. You're close to Waimea Canyon, Polihale Beach, and the beautiful Na Pali Coast. The west side truly is the best side.`,
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
        longDescription: `Welcome to Kimsey Beach Cottage, a completely renovated 1930s plantation-style oceanfront cottage located right next to Kimsey Beach House on the same property at Davidson's Surf Break in Kekaha.

This charming cottage retains its old Hawaii character while boasting all modern conveniences and comforts. Two master suites each feature a comfortable king-sized bed with their own en-suite bathrooms, plus a third full bathroom. Split AC units in both bedrooms keep you cool, and ceiling fans are located in every room.

The open living area features a queen-sized sleeper sofa for additional guests, and a separate sun room provides a peaceful reading nook. The fully equipped kitchen has everything you need for meal preparation, with views that look out over the ocean.

Sweeping ocean and Ni'ihau island views are visible from nearly every room. Step outside to the oceanfront lanai where you can watch surfers ride Davidson's famous break while enjoying your morning coffee.

Cable TV, DVD player, high-speed internet, gas grill, laundry room, and all linens and beach towels are included. This cottage can be rented alone or combined with Kimsey Beach House for groups of up to 15 guests.

Experience the authentic charm of old Hawaii plantation living with the comforts of a modern vacation home, all on one of Kauai's most beautiful and uncrowded beachfronts.`,
        photoFolder: "kekaha-cottage",
        photos: PHOTOS_KEKAHA_COTTAGE,
      },
    ],
  },
  {
    propertyId: 12,
    propertyName: "Incredible Kekaha Beachfront Estate for 10!",
    complexName: "Kekaha Beachfront Estate",
    address: "8515 Kekaha Rd, Kekaha, HI 96752",
    bookingTitle: "Kekaha Alaula Estate - Sleeps 10 | 5BR Oceanfront Plantation Home & Cottage | Kekaha, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of this beachfront estate. The main house and guest cottage may vary in decor and furnishings from photos shown.",
    combinedDescription: `This listing includes a luxury oceanfront plantation home and a beautifully restored 1930s guest cottage, both located on the same historic Alaula Estate in Kekaha on Kauai's sunny west side. Together they offer 5 bedrooms and can accommodate up to 10 guests, with direct beach access and breathtaking ocean and Ni'ihau sunset views.

Hale Ohana is an exquisite 2-story plantation-style home (~2,400 sq ft) with 3 bedrooms and 3 bathrooms. Features retractable sliding glass doors, solid teak furnishings, soapstone countertops, a wet bar, and wrap-around lanais on both levels. Sleeps 6 with a King bed and 2 Queen beds. Split AC in all bedrooms.

Hale Alaula Cottage is a restored 1930s beachfront plantation cottage (~900 sq ft) with 2 bedrooms and 2 bathrooms, featuring vintage Hawaiian decor and a large covered lanai overlooking the estate's manicured tropical grounds. Sleeps 4 and shares direct beach access with the main home.

The private estate grounds offer a truly unique Hawaiian experience with direct beachfront access, spectacular sunsets, and proximity to Waimea Canyon, Polihale Beach, and the stunning Na Pali Coast.`,
    hasPhotos: true,
    units: [
      {
        id: "prop12-hale-ohana",
        unitNumber: "Hale Ohana",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~2,400",
        maxGuests: 6,
        shortDescription: "Luxury 2-story oceanfront plantation home on the Alaula Estate. Retractable glass doors, soapstone counters, teak furnishings, wet bar, split AC, wrap-around lanai with ocean and sunset views. Sleeps 6 with King and 2 Queens.",
        longDescription: `Welcome to Hale Ohana, an exquisite oceanfront luxury plantation-style vacation home located on the historic Alaula Estate on Kauai's sunny west side in Kekaha.

This beautifully appointed two-story home features retractable sliding glass doors that open to spacious lanais, creating an open-air ambiance while enjoying lavishly appointed living areas with tropically covered solid teak furnishings. Soapstone countertops and sea grass floor coverings add authentic Hawaiian elegance.

The upstairs master suite is a private retreat featuring a large bedroom, adjoining custom bathroom, and access to the "Great Room" with a wet bar and spectacular ocean views from the spacious upper lanai - perfect for entertaining or simply watching the sun set over Ni'ihau Island.

The main floor offers two guest bedrooms with queen beds, each with ceiling fans and windows for natural trade wind circulation. Two full bathrooms on the main level feature travertine floors and showers. The fully equipped kitchen boasts high-end appliances and the finest amenities for the home chef.

Split AC units in all bedrooms ensure comfortable sleeping. A wrap-around covered lanai on both levels provides ample outdoor living space with breathtaking ocean views.

Located on a private beachfront plantation estate, Hale Ohana offers a truly unique Hawaiian experience. Walk directly to the beach, explore Waimea Canyon, or simply relax in paradise.`,
        photoFolder: "kekaha-ohana",
        photos: PHOTOS_KEKAHA_OHANA,
      },
      {
        id: "prop12-hale-alaula",
        unitNumber: "Hale Alaula Cottage",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~900",
        maxGuests: 4,
        shortDescription: "Restored 1930s plantation guest cottage on the same Alaula Estate. Vintage Hawaiian decor, spacious living and dining room, full kitchen, large covered lanai overlooking manicured tropical grounds. Sleeps 4.",
        longDescription: `Welcome to Hale Alaula Cottage, a beautifully restored 1930s beachfront plantation guest cottage on the historic Alaula Estate in Kekaha, Kauai.

This charming two-bedroom cottage features vintage Hawaiian decor that captures the authentic spirit of old Hawaii. The cottage includes a spacious living room, dining area, full kitchen, and two comfortable bedrooms, each with its own bathroom.

The large covered lanai is the highlight, looking out over the estate's palatial, manicured tropical grounds with views extending to the ocean beyond. Enjoy your morning coffee surrounded by swaying palms and fragrant tropical flowers.

The cottage is located on the same estate as Hale Ohana, sharing the beautiful grounds and direct beach access. Together, the two properties can accommodate up to 10 guests, making this an ideal setup for family reunions or group vacations.

All linens, beach towels, and kitchen essentials are provided. The west side of Kauai enjoys the most sunshine on the island, and Kekaha's laid-back community offers a genuine local Hawaiian experience far from the tourist crowds.

Nearby attractions include Waimea Canyon, Polihale Beach, and the stunning Na Pali Coast. Enjoy spectacular sunsets over the Forbidden Island of Ni'ihau every evening.`,
        photoFolder: "kekaha-ohana",
        photos: PHOTOS_KEKAHA_OHANA,
      },
    ],
  },
  {
    propertyId: 14,
    propertyName: "Fabulous 7 br 22 ocean view pool estate!",
    complexName: "Keauhou Estates",
    address: "78-6855 Ali'i Dr, Kailua-Kona, HI 96740",
    bookingTitle: "Keauhou Estates Halele'a - Sleeps 22 | 7BR Luxury Pool Estate with Ocean Views | Kailua-Kona, Big Island",
    sampleDisclaimer: "Photos shown are representative samples of this estate property. The main house and casita guest quarters may vary in decor and furnishings from photos shown.",
    combinedDescription: `This listing includes a stunning custom estate home and a separate casita guest quarters, both located within the private, gated community of Keauhou Estates on the Big Island's Kona Coast. Together they offer 6 bedrooms and can accommodate up to 12 guests, with ocean views, a 72-foot saltwater lap pool, and zoned AC throughout.

Halele'a Main House is a breathtaking 4-bedroom, 4-bathroom custom estate (~4,000 sq ft) with each suite offering a private bath, king bed, and ocean views overlooking Kailua Bay. The spacious circular kitchen with soaring high ceilings is designed for entertaining, and multiple lanais provide sun-soaked and shaded relaxation spaces.

The Halele'a Casita is a separate guest quarters (~800 sq ft) across the pool landing from the main house, with 2 bedrooms, 1 bathroom, king beds in each room, and individual AC units. Casita guests have full access to the main house kitchen, living areas, pool, and all outdoor amenities.

Located in exclusive Keauhou Estates with convenient access to Magic Sands Beach, Kahaluu Snorkel Beach, championship golf courses, and Kona Coast dining and shopping.`,
    hasPhotos: true,
    units: [
      {
        id: "prop14-halelea-main",
        unitNumber: "Halele'a Main House",
        bedrooms: 4,
        bathrooms: "4",
        sqft: "~4,000",
        maxGuests: 8,
        shortDescription: "Stunning 4-bedroom, 4-bath custom estate in gated Keauhou Estates. Each suite has private bath, king bed, and ocean views. Circular kitchen with high ceilings, 72ft saltwater lap pool, zoned AC, and multiple lanais overlooking Kailua Bay.",
        longDescription: `Welcome to Halele'a - the House of Joy - a breathtaking Hawaiian retreat in the private, gated community of Keauhou Estates on the Big Island's Kona Coast.

This stunning custom estate features four main suites, each uniquely designed with a private bathroom, Roku-enabled TV, king-sized bed, and captivating ocean views overlooking Kailua Bay. The upstairs primary suite offers unparalleled luxury with a private lanai and an elegant en-suite bathroom featuring a bathtub and shower.

The spacious circular kitchen with soaring high ceilings was designed for entertaining and culinary creativity, fully equipped with modern appliances, a large island with stool seating, and ample counter space. Indoor and outdoor dining areas seat up to eight guests.

The expansive open-plan design features large windows and glass doors that invite natural light and ocean breezes. Multiple seating areas and multiple lanais offer both sun-soaked and shaded relaxation spaces with breathtaking tropical garden and ocean views.

The crown jewel is the designer saltwater pool, approximately 72 feet long and ideal for lap swimming, with an adjacent plunge pool for added relaxation. Positioned to enjoy sunlight from morning to sunset.

Zoned air conditioning ensures comfort throughout. Located in exclusive Keauhou Estates with convenient access to Magic Sands Beach, Kahaluu Snorkel Beach, golf courses, shopping, and dining.`,
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
        longDescription: `The Halele'a Casita is a separate guest quarters located across a landing over the pool from the main house, within the same gated Keauhou Estates property.

This casita-style structure provides two additional bedrooms, each with a king bed, and a private bathroom. Individual AC units ensure comfortable sleeping. The casita offers a sense of privacy and seclusion while being just steps from the main house and its full amenities.

Guests in the casita have full access to the main house kitchen, living areas, the 72-foot saltwater lap pool, and all outdoor amenities including the BBQ area and multiple lanais.

The separate structure is ideal for couples who want their own private space, or for family members who appreciate a bit of independence while still being part of the group vacation experience.

From the casita, enjoy views of the tropical gardens, pool area, and ocean beyond. The gated Keauhou Estates community provides security and privacy, with Magic Sands Beach and Kahaluu Snorkel Beach nearby.`,
        photoFolder: "keauhou-estate",
        photos: PHOTOS_KEAUHOU,
      },
    ],
  },
  {
    propertyId: 18,
    propertyName: "Fabulous Six BR for 16 Poipu Kai! Steps to 3 Beaches!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Bldg 9, Koloa, HI 96756",
    bookingTitle: "Regency at Poipu Kai - Sleeps 16 | 6BR Villas Steps to 3 Beaches | Poipu, Kauai",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of two spacious 3-bedroom condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 6 bedrooms and can accommodate up to 14 guests, perfectly positioned steps from three of Poipu's finest beaches.

Unit 823 is a beautifully renovated 3-bedroom, 3-bathroom two-story condo (~1,800 sq ft) with AC throughout, stainless steel kitchen appliances, and a luxurious marble master bath. Sleeps 7 with a King bed, Queen bed, 2 Twins upstairs, and a futon.

Unit 724 is a designer-furnished 3-bedroom, 3-bathroom condo (~1,800 sq ft) with full central AC, a granite kitchen with breakfast bar, and a private garden-view lanai. Sleeps 7 with a King bed, Queen bed, 2 Twins, and a sofa bed.

All guests enjoy resort amenities including a sparkling pool, hot tub, tennis and pickleball courts, and tropical garden paths. Walk to Poipu Beach Park, Brennecke's Beach, and Shipwreck Beach in just 10 minutes.`,
    hasPhotos: true,
    units: [
      {
        id: "unit-823",
        unitNumber: "823",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Renovated 3-bedroom, 3-bath two-story Regency II condo in building 8 with AC throughout, stainless steel kitchen appliances, marble master bath, and an upstairs loft bedroom. Sleeps 7 with King, Queen, 2 Twins, and futon.",
        longDescription: `Welcome to Unit 823, a beautifully renovated 3-bedroom, 3-bathroom two-story condominium in Building 8 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning throughout and modern upgrades.

The approximately 1,800 sq ft layout spans two levels, providing a wonderful sense of space and privacy. The main level features an open living and dining area with sliding doors that open to the tropical gardens beyond. Natural light floods the interior through generously sized windows.

The renovated kitchen showcases stainless steel appliances, granite countertops, and ample storage. Whether you are whipping up a quick breakfast or hosting a dinner for your group, this kitchen is well-equipped for every occasion.

The master bedroom on the main level offers a King bed and a luxurious marble en-suite bathroom. The second bedroom features a Queen bed with its own bath. Upstairs, the loft-style third bedroom has 2 Twin beds and a futon for additional sleeping, plus a third full bathroom. Air conditioning keeps every room cool and comfortable.

Just steps from your front door, enjoy the resort's sparkling pool, soothing hot tub, and tennis and pickleball courts. The tropical garden paths are perfect for a morning stroll or evening walk.

Three of Poipu's most beautiful beaches are within easy walking distance. Explore the tidepools at Shipwreck Beach, bodysurf at Brennecke's Beach, or build sandcastles at family-friendly Poipu Beach Park.`,
        photoFolder: "unit-924",
        photos: PHOTOS_924,
      },
      {
        id: "unit-724",
        unitNumber: "724",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Designer-furnished 3-bedroom, 3-bath Regency II condo in building 7 with full AC, granite kitchen, private garden-view lanai, and three full bathrooms. Sleeps 7 with King, Queen, 2 Twins, and a sofa bed.",
        longDescription: `Welcome to Unit 724, a tastefully appointed 3-bedroom, 3-bathroom condominium in Building 7 of the Regency at Poipu Kai resort. This Regency II unit features full central air conditioning and designer furnishings that blend island style with modern comfort.

The approximately 1,800 sq ft interior opens to a generous great room where the living area, dining space, and kitchen create one cohesive entertaining space. The private lanai overlooks a lush garden setting, offering a peaceful outdoor retreat.

The granite kitchen is a highlight, with quality appliances, generous counter space, and a breakfast bar for quick meals. The kitchen is fully stocked with cookware, dishes, and utensils, making it easy to prepare meals at home.

Three full bathrooms ensure comfort for all guests. The master bedroom features a King bed with en-suite bath, the second bedroom has a Queen bed, and the third bedroom offers 2 Twin beds. A sofa bed in the living area sleeps a 7th guest.

Resort amenities at the Regency at Poipu Kai include a swimming pool, hot tub, tennis and pickleball courts, and winding tropical garden paths. The beautifully maintained grounds create a resort-like atmosphere.

Walk to three stunning south shore beaches in just 10 minutes. Snorkel among colorful fish at Poipu Beach Park, ride the famous shore break at Brennecke's Beach, or explore the dramatic cliffs at Shipwreck Beach.`,
        photoFolder: "unit-423",
        photos: PHOTOS_423,
      },
    ],
  },
  {
    propertyId: 19,
    propertyName: "Gorgeous Princeville 5 bedroom condos for 14!",
    complexName: "Mauna Kai Princeville",
    address: "3920 Wyllie Rd, Princeville, HI 96722",
    bookingTitle: "Mauna Kai Princeville - Sleeps 14 | 5BR Resort Condos near Hideaways Beach | Princeville, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of units within Mauna Kai. Individual units may vary in decor, furnishings, and layout.",
    combinedDescription: `This listing is comprised of two comfortable condos within the Mauna Kai resort community in Princeville, just a short walk apart from each other within the complex. Together they offer 5 bedrooms and can accommodate up to 14 guests, providing a wonderful home base for exploring Kauai's spectacular North Shore.

Unit 9 is a bright two-story 3-bedroom, 2-bathroom condo (~1,600 sq ft) with mountain views, a fully equipped kitchen with granite counters, gas grill on the deck, and outdoor dining. Sleeps 8 with a King master, Queen second and third bedrooms, and a queen sofa bed. Central AC throughout.

Unit 11 is a comfortable ground-floor 2-bedroom, 2-bathroom condo (~1,200 sq ft) with garden views, a covered lanai, and a full kitchen. Sleeps 6 with Queen beds in both bedrooms and a sofa sleeper. Walkable to Princeville shops and restaurants.

Both units enjoy access to Mauna Kai's shared pool and hot tub. Hideaways Beach is just two miles away, Hanalei Bay is four miles, and the spectacular Na Pali Coast is accessible for scenic hiking nearby.`,
    hasPhotos: false,
    units: [
      {
        id: "prop19-mk-9",
        unitNumber: "9",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~1,600",
        maxGuests: 8,
        shortDescription: "Bright two-story 3BR/2BA condo with mountain views, shared pool and hot tub. Fully equipped kitchen with granite counters, gas grill on deck, and outdoor dining. King master, queen second and third bedrooms, plus queen sofa bed. Near Hideaways Beach.",
        longDescription: `Welcome to Mauna Kai Unit 9, a spacious two-story condominium in the Mauna Kai resort community in Princeville on Kauai's North Shore.

This bright and airy condo features an open floor plan that seamlessly combines the kitchen, living room, and dining area into one large gathering space. Floor-to-ceiling windows bring in natural light and showcase the surrounding mountain and garden views.

The fully equipped kitchen features stainless steel appliances, gorgeous granite countertops, and all the cooking essentials for preparing meals during your stay. A gas grill on the deck allows for outdoor cooking, and the outdoor dining area and comfortable seating make the deck an extension of your living space.

The king-bedded master suite, queen-bedded second bedroom, and queen-bedded third bedroom provide comfortable sleeping for up to six. A queen sofa bed in the living area sleeps two more. Central AC keeps the entire unit comfortable.

Mauna Kai Unit 9 grants guests access to the shared outdoor pool and hot tub, perfect for relaxing after a day of North Shore adventures. Water sports gear is available for guest use.

Princeville offers jaw-dropping beaches, top golf courses, and breathtaking cliffs. Hideaways Beach is just two miles away, Hanalei Bay and its famous pier are four miles, and the spectacular Na Pali Coast is accessible for scenic hiking nearby.`,
        photoFolder: "",
        photos: [],
      },
      {
        id: "prop19-mk-11",
        unitNumber: "11",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,200",
        maxGuests: 6,
        shortDescription: "Comfortable 2BR/2BA ground-floor condo with garden views, shared pool, full kitchen, and covered lanai. Queen beds in both bedrooms plus sofa sleeper. Walkable to Princeville shops and restaurants.",
        longDescription: `Welcome to Mauna Kai Unit 11, a comfortable ground-floor 2-bedroom, 2-bathroom condominium in the Mauna Kai resort community in beautiful Princeville.

This well-maintained unit offers a relaxed island atmosphere with garden views from the covered lanai. The open floor plan creates a spacious feel, with comfortable living areas flowing into the fully equipped kitchen and dining space.

Both bedrooms feature queen beds with ceiling fans and their own adjacent bathrooms. A sofa sleeper in the living area accommodates additional guests. The kitchen is fully stocked with cookware, dishes, and modern appliances.

A covered lanai provides the perfect spot for morning coffee or evening relaxation. In-unit washer and dryer, WiFi, and cable TV are included.

Guests enjoy access to the Mauna Kai shared pool and BBQ area. The resort's convenient Princeville location puts you close to shopping, dining, and some of Kauai's most spectacular scenery.

Explore the golden sands of Hideaways Beach, snorkel at Queen's Bath, or venture to Hanalei for surfing and dining. The Na Pali Coast's dramatic cliffs and hiking trails are a short drive away.`,
        photoFolder: "",
        photos: [],
      },
    ],
  },
  {
    propertyId: 20,
    propertyName: "Gorgeous Princeville 6 bedroom condos for 18!",
    complexName: "Mauna Kai Princeville",
    address: "3920 Wyllie Rd, Princeville, HI 96722",
    bookingTitle: "Mauna Kai Princeville - Sleeps 18 | 6BR Resort Condos with Pool near Hideaways Beach | Princeville, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of units within Mauna Kai. Individual units may vary in decor, furnishings, and layout.",
    combinedDescription: `This listing is comprised of two spacious 3-bedroom condos within the Mauna Kai resort community in Princeville, just a short walk apart from each other within the complex. Together they offer 6 bedrooms and can accommodate up to 16 guests, perfect for large groups looking to experience Kauai's breathtaking North Shore.

Unit 7B is a 3-bedroom, 3-bathroom two-story condo (~1,600 sq ft) with central AC, a King master suite, Queen second and third bedrooms, a loft sleeping area, and a queen sleeper sofa. The open-concept living area opens to a covered lanai with tropical breezes and garden views.

Unit 8 is a bright 3-bedroom, 2-bathroom two-story condo (~1,600 sq ft) with garden and mountain views, a stainless steel kitchen with granite counters, and a lanai with comfortable seating. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa.

Both units enjoy access to Mauna Kai's shared pool and hot tub. Princeville's convenient location offers easy access to Hideaways Beach, Hanalei Bay, the Princeville golf courses, and the dramatic Na Pali Coast.`,
    hasPhotos: false,
    units: [
      {
        id: "prop20-mk-7b",
        unitNumber: "7B",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,600",
        maxGuests: 8,
        shortDescription: "Spacious 3BR/3BA two-story condo with ocean glimpses, shared pool, fully equipped kitchen, and covered lanai. King master suite, queen bedrooms, loft sleeping area, and queen sleeper sofa. Central AC throughout.",
        longDescription: `Welcome to Mauna Kai Unit 7B, a spacious 3-bedroom, 3-bathroom two-story condominium in Princeville's Mauna Kai resort. This well-appointed unit features central AC and a layout that maximizes space and privacy.

The main level features an open-concept living area with comfortable seating, a dining table, and a fully equipped kitchen. Sliding glass doors open to a covered lanai where you can enjoy the tropical breezes and garden views.

Three full bathrooms serve the three bedrooms. The king-bedded master suite includes an en-suite bath, while the second and third bedrooms feature queen beds. A loft area provides additional flexible sleeping space. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

The kitchen has everything you need for home cooking, from quality appliances to ample prep space. A washer and dryer in the unit add convenience.

Mauna Kai's shared pool and hot tub are just steps away. The resort location in Princeville puts you close to Hideaways Beach, the Princeville Botanical Gardens, and the gateway to the North Shore's most spectacular scenery.

From Hanalei Bay's famous crescent beach to the dramatic Na Pali Coast trails, Kauai's North Shore offers some of Hawaii's most breathtaking experiences right at your doorstep.`,
        photoFolder: "",
        photos: [],
      },
      {
        id: "prop20-mk-8",
        unitNumber: "8",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~1,600",
        maxGuests: 8,
        shortDescription: "Airy 3BR/2BA two-story condo with garden and mountain views. Open floor plan, stainless kitchen, lanai with seating, shared pool. King, queen, and twin bedrooms plus queen sleeper sofa. Near Princeville shops and beaches.",
        longDescription: `Welcome to Mauna Kai Unit 8, a bright and airy 3-bedroom, 2-bathroom two-story condo in Princeville's Mauna Kai resort community.

The open floor plan on the main level creates a wonderful gathering space where the kitchen, dining area, and living room flow together. Mountain and garden views from the windows and lanai remind you that you're in one of Hawaii's most beautiful locations.

The stainless steel kitchen is fully equipped for meal preparation, with granite counters and modern appliances. The lanai features comfortable seating for outdoor dining and relaxation.

The king-bedded master suite is on the main level with an en-suite bath. Two upstairs bedrooms offer a queen bed and twin beds respectively, sharing a full bath. A queen sleeper sofa in the living area provides additional sleeping for two more guests. WiFi, cable TV, in-unit washer/dryer, and all linens are included.

The shared pool and hot tub provide a refreshing retreat. Princeville's convenient location offers easy access to grocery stores, restaurants, and the Princeville golf courses.

Kauai's North Shore stretches before you with endless possibilities - from the turquoise waters of Anini Beach to the towering waterfalls along the Na Pali Coast. Hanalei's charming shops and restaurants are just a short drive away.`,
        photoFolder: "",
        photos: [],
      },
    ],
  },
  {
    propertyId: 21,
    propertyName: "Fabulous 8 bedrooms Poipu Kai steps to beach!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Bldg 2, Koloa, HI 96756",
    bookingTitle: "Regency at Poipu Kai - Sleeps 22 | 8BR Resort Villas Steps to Beach | Poipu, Kauai",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of three condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 8 bedrooms and can accommodate up to 20 guests, making this one of the largest group options available steps from Poipu's famous beaches.

Unit 824 is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) with central AC, an open floor plan, full granite kitchen, covered dining lanai, and a master suite with luxurious jetted tub. Sleeps 7 with a King bed, Queen bed, 2 Twins, and a futon.

Unit 923 is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) with central AC, charming Hawaiian decor, garden views, a private balcony, and a walk-in shower in the master bath. Sleeps 7 with a King bed, Queen bed, 2 Twins, and a sofa bed.

Unit 914 is a sleek 2-bedroom, 2-bathroom condo (~1,250 sq ft) with central AC, King beds in both rooms, a stainless steel kitchen, smart TVs, and a queen sleeper sofa. Sleeps 6.

All guests enjoy resort amenities including a shimmering pool, hot tub, tennis and pickleball courts, and tropical gardens. Walk to Poipu Beach Park, Brennecke's Beach, and Shipwreck Beach in under 10 minutes.`,
    hasPhotos: true,
    units: [
      {
        id: "unit-824",
        unitNumber: "824",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Spacious 3-bedroom, 3-bath Regency II condo in building 8 with central AC, open floor plan, full granite kitchen, covered dining lanai, and a master suite with jetted tub. Sleeps 7 with King, Queen, 2 Twins, and futon.",
        longDescription: `Welcome to Unit 824, a generously proportioned 3-bedroom, 3-bathroom condominium in Building 8 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning and an inviting open floor plan designed for comfortable group living.

The approximately 1,800 sq ft interior centers around a spacious great room where living, dining, and kitchen areas blend together. The covered dining lanai extends the entertaining space outdoors, ideal for tropical dining under the stars or lazy afternoon relaxation.

The full granite kitchen is equipped with modern appliances, generous prep space, and everything from blenders to bakeware. The open design keeps the chef connected with family and friends throughout the living area.

The master suite is a true sanctuary with a King bed and spa-inspired en-suite bathroom featuring a luxurious jetted tub and walk-in shower. The second bedroom offers a Queen bed, and the upstairs third bedroom has 2 Twin beds plus a futon for additional sleeping. Three full bathrooms ensure privacy for all guests.

Enjoy resort amenities just steps from your door, including a shimmering pool, relaxing hot tub, and tennis and pickleball courts surrounded by tropical gardens. The well-maintained grounds provide a serene backdrop for your vacation.

Walk to three world-class Poipu beaches in under 10 minutes. Snorkel with sea turtles at Poipu Beach Park, catch waves at Brennecke's Beach, or take a sunset stroll along the dramatic Shipwreck Beach coastline.`,
        photoFolder: "unit-621",
        photos: PHOTOS_621,
      },
      {
        id: "unit-923",
        unitNumber: "923",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Hawaiian-inspired 3-bedroom, 3-bath Regency II condo in building 9 with AC, open living/dining/kitchen layout, garden views, private balcony, and walk-in shower. Sleeps 7 with King, Queen, 2 Twins, and sofa bed.",
        longDescription: `Welcome to Unit 923, a warmly decorated 3-bedroom, 3-bathroom condominium in Building 9 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning and charming Hawaiian decor that reflects the beauty of the islands.

The approximately 1,800 sq ft home offers an open living, dining, and kitchen layout that encourages togetherness. Garden views from the living area and a private balcony create a connection with the lush tropical surroundings that make Kauai special.

The kitchen is fully equipped with modern appliances, granite counters, and plenty of space for group meal preparation. The dining area seats the whole party comfortably, and the breakfast bar adds extra seating for casual meals.

The master bedroom features a King bed with en-suite bathroom including a walk-in shower. The second bedroom has a comfortable Queen bed, and the third bedroom offers 2 Twin beds. A sofa bed in the living area accommodates a 7th guest. Three full bathrooms provide convenience and privacy.

The Regency at Poipu Kai resort amenities are at your fingertips: a sparkling pool, hot tub, and tennis and pickleball courts nestled among tropical gardens. The complex's central location puts you close to shops and dining.

Poipu's celebrated beaches are mere minutes away on foot. Discover the vibrant underwater world at Poipu Beach Park, body surf the legendary waves at Brennecke's Beach, or hike the scenic trail at Shipwreck Beach.`,
        photoFolder: "unit-924",
        photos: PHOTOS_924,
      },
      {
        id: "unit-914",
        unitNumber: "914",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,250",
        maxGuests: 6,
        shortDescription: "Modern 2-bedroom, 2-bath Regency II condo in building 9 with central AC, King beds in both rooms, stainless steel kitchen, and a private lanai. Sleeps 6 with two King beds and a queen sleeper sofa.",
        longDescription: `Welcome to Unit 914, a sleek and modern 2-bedroom, 2-bathroom condominium in Building 9 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning and tasteful contemporary updates throughout.

The approximately 1,250 sq ft layout is efficiently designed with an open living area that connects to the kitchen and dining space. A private lanai offers a quiet retreat with views of the tropical gardens. Smart TVs are available in the living area and bedrooms.

The updated kitchen features stainless steel appliances, modern finishes, and is fully stocked for meal preparation. The dining area provides ample seating for your group, and the open layout keeps everyone connected.

Both bedrooms feature plush King beds for maximum sleeping comfort. The master bedroom includes an en-suite bathroom, while the second bedroom is adjacent to the second full bath. A queen sleeper sofa in the living area provides additional sleeping for two more guests. Modern updates in both bathrooms include contemporary fixtures and finishes.

Resort amenities including the swimming pool, hot tub, and tennis and pickleball courts are just a short walk from your door. The tropical gardens and well-maintained grounds create a peaceful resort atmosphere.

Kauai's famous south shore beaches are a leisurely 10-minute walk from the complex. Enjoy world-class snorkeling at Poipu Beach Park, exciting body surfing at Brennecke's Beach, or peaceful sunset views from Shipwreck Beach.`,
        photoFolder: "unit-911",
        photos: PHOTOS_911,
      },
    ],
  },
  {
    propertyId: 23,
    propertyName: "Incredible 5 bedrooms for 14 at Lydgate Beach!",
    complexName: "Kaha Lani Resort",
    address: "4460 Nehe Rd, Lihue, HI 96766",
    bookingTitle: "Kaha Lani Resort Kapaa - Sleeps 14 | 5BR Oceanfront Condos at Lydgate Beach | Kapaa, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of units within Kaha Lani Resort. Individual units may vary in decor, furnishings, and layout.",
    combinedDescription: `This listing is comprised of two oceanfront condos within the Kaha Lani Resort in Kapaa, just a short walk apart from each other within the complex. Together they offer 5 bedrooms and can accommodate up to 14 guests, with stunning ocean views and steps to family-friendly Lydgate Beach Park.

Unit 339 is a spacious 3-bedroom, 3-bathroom oceanfront condo (~1,700 sq ft) with an open floor plan, ocean views from the lanai, and AC throughout. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa.

Unit 221 is a comfortable 2-bedroom, 2-bathroom ocean view condo (~1,200 sq ft) with a renovated kitchen, private lanai with ocean views, and a relaxing tropical retreat feel. Sleeps 6 with a King master, Queen second bedroom, and a sofa sleeper.

Kaha Lani Resort features a pool, hot tub, and BBQ area. The resort sits directly adjacent to Lydgate Beach Park with its protected swimming lagoon and Kamalani Playground. Kapaa's charming town center offers eclectic shopping, dining, and the scenic coastal bike path.`,
    hasPhotos: false,
    units: [
      {
        id: "prop23-kl-3br",
        unitNumber: "339",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,700",
        maxGuests: 8,
        shortDescription: "Spacious 3BR/3BA oceanfront condo at Kaha Lani Resort. Open floor plan, fully equipped kitchen, private lanai with ocean views. King master, queen second, twins third, and queen sleeper sofa. Steps to Lydgate Beach and playground. AC throughout.",
        longDescription: `Welcome to Kaha Lani Unit 339, a spacious 3-bedroom, 3-bathroom oceanfront condominium at the Kaha Lani Resort in Kapaa on Kauai's Coconut Coast.

This well-appointed condo features an open floor plan with ocean views from the main living areas and private lanai. The fully equipped kitchen has modern appliances, granite counters, and everything needed for meal preparation. The dining area seats your full group comfortably.

The king-bedded master suite includes an en-suite bathroom and ocean views. The second bedroom offers a queen bed, and the third bedroom has twin beds - both with adjacent bathrooms. A queen sleeper sofa in the living area provides additional sleeping for two more guests. AC throughout keeps you comfortable in Kapaa's tropical climate.

The private lanai is perfect for morning coffee while watching the sunrise over the Pacific. A washer/dryer, WiFi, cable TV, and all linens are included.

Kaha Lani Resort features a pool, hot tub, and BBQ area. The resort sits directly adjacent to Lydgate Beach Park, one of Kauai's best family beaches with a protected swimming lagoon, snorkeling, and the expansive Kamalani Playground.

Kapaa's Coconut Coast is centrally located on Kauai, making it easy to explore both the North Shore and South Shore. The charming Kapaa town offers eclectic shopping, dining, and the scenic coastal bike path.`,
        photoFolder: "",
        photos: [],
      },
      {
        id: "prop23-kl-2br",
        unitNumber: "221",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,200",
        maxGuests: 6,
        shortDescription: "Ocean view 2BR/2BA condo at Kaha Lani Resort. Renovated kitchen, comfortable living areas, and a private lanai overlooking the ocean. King master and queen second bedroom. Steps to Lydgate Beach.",
        longDescription: `Welcome to Kaha Lani Unit 221, a comfortable 2-bedroom, 2-bathroom ocean view condominium at the Kaha Lani Resort in Kapaa.

This well-maintained unit features a renovated kitchen with modern appliances and granite counters. The open living and dining area flows to a private lanai with ocean views, creating a relaxing tropical retreat.

The king-bedded master suite has an en-suite bathroom, and the queen-bedded second bedroom is adjacent to the second full bath. A sofa sleeper in the living area provides space for additional guests. WiFi, cable TV, washer/dryer, and all linens included.

Take advantage of Kaha Lani Resort's pool, hot tub, and BBQ facilities. Walk directly to Lydgate Beach Park's protected swimming lagoon, ideal for families with its calm waters and abundant sea life.

Kapaa town is minutes away with its bike path, shopping, and diverse dining options. The Coconut Coast location provides easy access to attractions across the island.`,
        photoFolder: "",
        photos: [],
      },
    ],
  },
  {
    propertyId: 24,
    propertyName: "Gorgeous 5 bedroom condos for 10 on Kapaa coast!",
    complexName: "Lae Nani Resort",
    address: "410 Papaloa Rd, Kapaa, HI 96746",
    bookingTitle: "Lae Nani Resort Kapaa - Sleeps 10 | 5BR Oceanfront Condos on Kapaa's Coconut Coast | Kauai",
    sampleDisclaimer: "Photos shown are representative samples of units within Lae Nani Resort. Individual units may vary in decor, furnishings, and layout.",
    combinedDescription: `This listing is comprised of two oceanfront condos within the Lae Nani Resort in Kapaa, just a short walk apart from each other within the complex. Together they offer 5 bedrooms and can accommodate up to 14 guests, with ocean views and access to the resort's own private sandy beach cove.

Unit 314 is an oceanfront 3-bedroom, 2-bathroom corner condo (~1,500 sq ft) with expansive ocean views, a full kitchen, and a private lanai. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa. AC and ceiling fans throughout.

Unit 225 is a charming 2-bedroom, 2-bathroom condo (~1,100 sq ft) set in a tropical garden with ocean views, a full kitchen, and a private lanai. Sleeps 6 with a King master, Queen second bedroom, and a queen sleeper sofa. AC and ceiling fans included.

Lae Nani Resort sits on a rocky oceanfront point with a private beach cove perfect for swimming and snorkeling. The resort pool, tennis court, and BBQ area round out the amenities. Kapaa's vibrant town center is walking distance with its coastal bike path, boutiques, and diverse restaurants.`,
    hasPhotos: false,
    units: [
      {
        id: "prop24-ln-3br",
        unitNumber: "314",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~1,500",
        maxGuests: 8,
        shortDescription: "Oceanfront 3BR/2BA condo at Lae Nani Resort. Open living with ocean views, full kitchen, private lanai, pool and tennis. King master, queen and twin bedrooms plus queen sleeper sofa. Steps to a private sandy beach cove.",
        longDescription: `Welcome to Lae Nani Unit 314, an oceanfront 3-bedroom, 2-bathroom condominium at the Lae Nani Resort in Kapaa on Kauai's beautiful Coconut Coast.

This corner unit offers expansive ocean views from the living area and private lanai. The open layout creates a bright, airy space with the kitchen, dining, and living areas flowing together.

The fully equipped kitchen features modern appliances and plenty of counter space. The king-bedded master suite has an en-suite bath and ocean views. The second bedroom offers a queen bed, and the third bedroom has twin beds. A queen sleeper sofa in the living area provides additional sleeping for two more guests. AC and ceiling fans keep all rooms comfortable.

Lae Nani Resort sits on a rocky oceanfront point with its own private sandy beach cove - perfect for swimming and snorkeling. The resort pool, tennis court, and BBQ area provide additional amenities.

Kapaa's vibrant town center is walking distance, offering the popular coastal bike path, eclectic boutiques, farmers markets, and diverse restaurants. Central Kauai location makes day trips to any part of the island easy and convenient.`,
        photoFolder: "",
        photos: [],
      },
      {
        id: "prop24-ln-2br",
        unitNumber: "225",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,100",
        maxGuests: 6,
        shortDescription: "Charming 2BR/2BA condo at Lae Nani Resort with ocean views, tropical garden setting, full kitchen, and lanai. King and queen bedrooms plus queen sleeper sofa. Private beach cove, pool, and tennis court.",
        longDescription: `Welcome to Lae Nani Unit 225, a charming 2-bedroom, 2-bathroom condominium at the Lae Nani Resort in Kapaa.

Set in a tropical garden with ocean views, this comfortable condo features a full kitchen, spacious living and dining areas, and a private lanai. The king-bedded master has an en-suite bath, and the queen-bedded second bedroom is near the second bath. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

WiFi, cable TV, ceiling fans, AC, and all linens are included. An in-unit washer/dryer adds convenience.

Lae Nani's private beach cove offers some of the best swimming on Kauai's east side. The resort pool, tennis court, and landscaped grounds provide a relaxing base for your Kauai vacation.

Walk to Kapaa town for shopping, dining, and the scenic coastal bike path. The central location makes exploring Waimea Canyon, the North Shore, and Poipu equally accessible.`,
        photoFolder: "",
        photos: [],
      },
    ],
  },
  {
    propertyId: 26,
    propertyName: "Fabulous 7 bedroom for 23 near Magic Sands Beach!",
    complexName: "Keauhou Estates",
    address: "78-6920 Ali'i Dr, Kailua-Kona, HI 96740",
    bookingTitle: "Keauhou Estates - Sleeps 23 | 7BR Luxury Estate with Pool near Magic Sands Beach | Kailua-Kona, Big Island",
    sampleDisclaimer: "Photos shown are representative samples of this estate property. The main house and guest wing may vary in decor and furnishings from photos shown.",
    combinedDescription: `This listing includes a grand main estate home and a separate guest wing, both located on the same property within the exclusive gated community of Keauhou Estates on the Big Island's stunning Kona Coast. Together they offer 7 bedrooms and can accommodate up to 23 guests, with a private pool, ocean views, and zoned AC throughout.

The Main Estate is a grand 5-bedroom, 5-bathroom home (~4,500 sq ft) with five en-suite king bedrooms, a gourmet kitchen with professional-grade appliances, high ceilings, and floor-to-ceiling ocean-view windows. The private pool area is the centerpiece of the outdoor space, surrounded by tropical landscaping and views of Kailua Bay. Sleeps 15.

The Guest Wing is a separate living space (~900 sq ft) within the estate grounds, offering 2 bedrooms with king beds, a private bathroom, AC, and lanai access. Guest wing occupants enjoy full access to the main estate's kitchen, living areas, pool, and outdoor amenities. Sleeps 8.

Located in the gated Keauhou Estates community with 24-hour security, minutes from Magic Sands Beach and Kahaluu Snorkel Beach. Championship golf courses, Kona Coast dining, and world-class coffee tours are all nearby.`,
    hasPhotos: true,
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

Magic Sands Beach and Kahaluu Snorkel Beach are minutes away. Explore the historic Kona Coast, enjoy world-class coffee tours, or tee off at nearby championship golf courses.`,
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

The Keauhou Estates gated community provides a secure, peaceful environment with easy access to Kona's best attractions, beaches, and dining.`,
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
    bookingTitle: "Poipu Beachside - Sleeps 17 | 7BR Ocean View Homes Steps to Brennecke's Beach | Poipu, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of these beachside homes. Individual homes may vary in decor, furnishings, and layout.",
    combinedDescription: `This listing includes two beachside homes located on the same property, just 60 yards from famous Brennecke's Beach on Kauai's sunny Poipu coast. Together they offer 7 bedrooms and can accommodate up to 17 guests, with ocean views and an unbeatable beach location.

Beach House A is a spacious 4-bedroom, 3-bathroom home (~2,200 sq ft) with an open floor plan, ocean views, a covered lanai, and tropical landscaping. Sleeps 10 with a King master suite, Queen and Twin bedrooms, and a queen sleeper sofa. AC and ceiling fans throughout.

Beach House B is a charming 3-bedroom, 3-bathroom home (~1,800 sq ft) with island-style decor and the luxury of private bathrooms for each bedroom. Sleeps 7 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa. Covered lanai with ocean views and a BBQ grill.

The location is unbeatable - Brennecke's Beach for world-class body surfing, Poipu Beach Park for calm-water snorkeling, and Shipwreck Beach's dramatic coastline are all within a short walk. Poipu offers excellent dining, shopping, and the National Tropical Botanical Garden.`,
    hasPhotos: false,
    units: [
      {
        id: "prop28-house-a",
        unitNumber: "Beach House A",
        bedrooms: 4,
        bathrooms: "3",
        sqft: "~2,200",
        maxGuests: 10,
        shortDescription: "Ocean view 4-bedroom, 3-bath home just 60 yards from Brennecke's Beach. Open floor plan, fully equipped kitchen, covered lanai with ocean views, and tropical landscaping. King master suite, queen and twin bedrooms, and queen sleeper sofa.",
        longDescription: `Welcome to Beach House A, a spacious 4-bedroom, 3-bathroom home located just 60 yards from famous Brennecke's Beach on Kauai's sunny south shore.

This well-appointed home features an open floor plan with the living room, dining area, and kitchen flowing together to create a perfect gathering space. Large windows frame ocean views, and the covered lanai extends your living space outdoors with comfortable seating and dining.

The fully equipped kitchen has everything needed for meal preparation, from modern appliances to a full complement of cookware and serving ware. The dining area comfortably seats your group.

The king-bedded master suite includes a private en-suite bathroom. Additional bedrooms offer queen and twin bed configurations with two more full bathrooms. A queen sleeper sofa in the living area provides additional sleeping for two more guests. AC and ceiling fans keep all rooms comfortable. WiFi, cable TV, washer/dryer, and all linens provided.

Step outside and walk to Brennecke's Beach in just minutes for world-class body surfing and boogie boarding. Poipu Beach Park is equally close for calm-water swimming and snorkeling. Shipwreck Beach's dramatic cliffs are a short walk along the coast.

The Poipu area offers excellent dining, shopping, and the National Tropical Botanical Garden. This is Kauai's premier resort coast with the island's most consistent sunny weather.`,
        photoFolder: "",
        photos: [],
      },
      {
        id: "prop28-house-b",
        unitNumber: "Beach House B",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Charming 3-bedroom, 3-bath home steps from Brennecke's Beach. Island-style decor, lanai with ocean views, full kitchen, and private bathrooms for each bedroom. King, queen, and twin beds, plus queen sleeper sofa.",
        longDescription: `Welcome to Beach House B, a charming 3-bedroom, 3-bathroom home located steps from Brennecke's Beach on Poipu's renowned south shore.

Island-style decor and comfortable furnishings create a welcoming atmosphere throughout this well-maintained home. Each of the three bedrooms has its own private bathroom - a rare luxury that ensures comfort for all guests.

The king-bedded master, queen second bedroom, and twin-bedded third bedroom provide comfortable sleeping. A queen sleeper sofa in the living area provides additional sleeping for two more guests. The open living area connects to a full kitchen with modern appliances and a dining area. The covered lanai offers ocean views and outdoor dining.

AC, ceiling fans, WiFi, cable TV, washer/dryer, beach chairs, beach towels, and all linens are provided. A BBQ grill on the lanai makes outdoor cooking a pleasure.

The location is unbeatable - Brennecke's Beach, Poipu Beach Park, and Shipwreck Beach are all within a short walk. Enjoy some of Hawaii's best snorkeling, body surfing, and sunset watching right at your doorstep.`,
        photoFolder: "",
        photos: [],
      },
    ],
  },
  {
    propertyId: 29,
    propertyName: "Ocean view 7 bedrooms for 14 above Anini Beach!",
    complexName: "Kaiulani of Princeville",
    address: "4100 Queen Emma's Dr, Princeville, HI 96722",
    bookingTitle: "Kaiulani of Princeville - Sleeps 14 | 7BR Ocean View Townhomes above Anini Beach | Princeville, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of townhome units within Kaiulani of Princeville. Individual units may vary in decor, furnishings, and layout.",
    combinedDescription: `This listing is comprised of three townhome units within the Kaiulani of Princeville community, perched above beautiful Anini Beach on Kauai's North Shore. Together they offer 7 bedrooms and can accommodate up to 17 guests, with ocean and mountain views and access to the community pool.

Unit 5 is a spacious 3-bedroom, 2.5-bathroom two-story townhome (~1,800 sq ft) with high vaulted ceilings, a fully equipped kitchen, and a covered lanai with mountain and partial ocean views. Sleeps 8 with a King master upstairs, Queen and Twin bedrooms, and a queen sleeper sofa.

Units 6 and 7 are two adjacent 2-bedroom townhomes combined to create a 4-bedroom, 3-bathroom vacation home (~2,400 sq ft). Each unit has its own kitchen, living area, lanai, and queen sleeper sofa, providing flexibility for your group. Four bedrooms with King and Queen beds throughout. Sleeps 9.

Anini Beach below offers some of the calmest, clearest waters on Kauai, ideal for swimming, snorkeling, and kayaking. Princeville puts you at the gateway to Kauai's North Shore, with Hanalei Bay, the Na Pali Coast, and countless waterfalls all within reach.`,
    hasPhotos: false,
    units: [
      {
        id: "prop29-kai-3br",
        unitNumber: "Unit 5",
        bedrooms: 3,
        bathrooms: "2.5",
        sqft: "~1,800",
        maxGuests: 8,
        shortDescription: "Ocean view 3BR/2.5BA two-story townhome above Anini Beach. Open living with high ceilings, full kitchen, covered lanai, and mountain views. King master upstairs, queen and twin bedrooms, and queen sleeper sofa. Pool access.",
        longDescription: `Welcome to Kaiulani of Princeville Unit 5, a spacious 3-bedroom, 2.5-bathroom two-story townhome perched above beautiful Anini Beach on Kauai's North Shore.

High vaulted ceilings and an open floor plan create an impressive sense of space in the main living area. The fully equipped kitchen, dining area, and comfortable living room flow together, with sliding glass doors opening to a covered lanai with mountain and partial ocean views.

The upstairs king-bedded master suite features an en-suite bathroom and views of the surrounding greenery. The second bedroom offers a queen bed, and the third bedroom has twin beds. A queen sleeper sofa in the living area provides additional sleeping for two more guests. A half bath on the main level serves common areas. Ceiling fans and trade winds keep the home comfortable.

This townhome community features a shared pool and tropical landscaped grounds. The quiet residential setting offers privacy and peace while being conveniently located in Princeville.

Anini Beach, one of Kauai's most beautiful and protected beaches, is just down the hill - perfect for swimming, snorkeling, and windsurfing. The North Shore's legendary attractions including Hanalei Bay, Na Pali Coast, and the Kilauea Lighthouse are all easily accessible.`,
        photoFolder: "",
        photos: [],
      },
      {
        id: "prop29-kai-4br",
        unitNumber: "Units 6-7",
        bedrooms: 4,
        bathrooms: "3",
        sqft: "~2,400",
        maxGuests: 9,
        shortDescription: "Two adjacent 2BR townhomes combined for 4 bedrooms and 3 baths. Each unit has its own kitchen, living area, lanai, and queen sleeper sofa. King and queen beds throughout. Ocean and mountain views above Anini Beach.",
        longDescription: `Welcome to Kaiulani of Princeville Units 6 and 7, two adjacent 2-bedroom townhomes that combine to create a spacious 4-bedroom, 3-bathroom vacation home above Anini Beach.

Each townhome unit has its own fully equipped kitchen, living area, and covered lanai, providing flexibility for your group. The combined layout creates a large vacation home while allowing different parts of your group to have their own space and privacy.

Four bedrooms across the two units feature king and queen beds. Three full bathrooms ensure comfort for all guests. Each townhome includes a queen sleeper sofa in the living area, providing additional sleeping for more guests. Each kitchen is fully stocked with modern appliances, cookware, and dining essentials.

The covered lanais offer views of the mountains and ocean, perfect for relaxing with a tropical drink. Trade winds and ceiling fans provide natural cooling.

Kaiulani's shared pool and landscaped grounds create a peaceful retreat. Anini Beach below offers some of the calmest, clearest waters on Kauai - ideal for swimming, snorkeling, and kayaking.

Princeville puts you at the gateway to Kauai's North Shore, with Hanalei Bay, the Na Pali Coast, and countless waterfalls all within reach for unforgettable day trips.`,
        photoFolder: "",
        photos: [],
      },
    ],
  },
  {
    propertyId: 31,
    propertyName: "Fabulous 7 bedroom for 14 oceanfront Poipu pool home!",
    complexName: "Poipu Brenneckes Oceanfront",
    address: "2350 Ho'one Rd, Koloa, HI 96756",
    bookingTitle: "Poipu Oceanfront Pool Home - Sleeps 14 | 7BR Estate with Pool Steps to Brennecke's Beach | Poipu, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of this oceanfront estate. The main home and guest suite may vary in decor and furnishings from photos shown.",
    combinedDescription: `This listing includes a stunning oceanfront pool home and a separate guest suite, both located on the same estate property steps from Brennecke's Beach on Kauai's premier Poipu coast. Together they offer 7 bedrooms and can accommodate up to 14 guests, with ocean views, a private pool, and an unbeatable beachside location.

The Main Home is a spacious 5-bedroom, 3-bathroom oceanfront pool home (~3,000 sq ft) with an open layout designed to maximize ocean views, a gourmet kitchen with granite counters, and a private pool surrounded by tropical landscaping. Sleeps 10 with a King master suite, Queen-bedded rooms, Twin room, and a queen sleeper sofa. AC throughout.

The Guest Suite is a separate living space (~800 sq ft) adjacent to the main home with its own entrance, offering 2 bedrooms with Queen beds, a private bathroom, and full access to the main home's pool and outdoor amenities. Sleeps 4.

Walk to Brennecke's Beach, Poipu Beach Park, or Shipwreck Beach in minutes. This is one of Poipu's most coveted oceanfront locations, offering world-class snorkeling, dining, and dramatic coastal scenery.`,
    hasPhotos: false,
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

Walk to Brennecke's Beach, Poipu Beach Park, or Shipwreck Beach in minutes. This is one of Poipu's most coveted oceanfront locations.`,
        photoFolder: "",
        photos: [],
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

The unbeatable Poipu location puts Brennecke's Beach, Poipu Beach Park, and Shipwreck Beach all within walking distance. Enjoy Kauai's sunniest coast with its world-class snorkeling, dining, and dramatic coastal scenery.`,
        photoFolder: "",
        photos: [],
      },
    ],
  },
  {
    propertyId: 32,
    propertyName: "Gorgeous Poipu Townhomes for 12 with AC! 5 Bedrooms.",
    complexName: "Kiahuna Plantation",
    address: "2253 Poipu Rd, Unit A, Koloa, HI 96756",
    bookingTitle: "Kiahuna Plantation - Sleeps 12 | 5BR Beachfront Garden Condos with AC | Poipu Beach, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of units within Kiahuna Plantation. Individual units may vary in decor, furnishings, and layout.",
    combinedDescription: `This listing is comprised of two condos within Kiahuna Plantation, one of Poipu Beach's most beloved beachfront resort communities, set among 35 acres of lush tropical gardens originally landscaped for Hawaiian royalty. Together they offer 5 bedrooms and can accommodate up to 14 guests, with AC throughout and a garden walk to Poipu Beach.

Building 38 is a beachfront 3-bedroom, 3-bathroom condo (~1,500 sq ft) with AC, a tropical garden setting, a full kitchen, and private bathrooms for each bedroom. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa.

Building 2 is a garden view 2-bedroom, 2-bathroom condo (~1,100 sq ft) with AC, a full kitchen, and a lanai overlooking the tropical gardens. Sleeps 6 with a King master, Queen second bedroom, and a queen sleeper sofa.

Walk through the resort's spectacular gardens directly to Poipu Beach, consistently rated one of Hawaii's best. Nearby attractions include Spouting Horn, the National Tropical Botanical Garden, and the scenic Maha'ulepu Heritage Trail.`,
    hasPhotos: false,
    units: [
      {
        id: "prop32-kia-3br",
        unitNumber: "Building 38",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,500",
        maxGuests: 8,
        shortDescription: "Beachfront 3BR/3BA condo at Kiahuna Plantation with AC, tropical garden setting, full kitchen, and steps to Poipu Beach. King master, queen, and twin bedrooms plus queen sleeper sofa. Access to resort pool and grounds.",
        longDescription: `Welcome to this 3-bedroom, 3-bathroom condominium at Kiahuna Plantation, one of Poipu Beach's most beloved beachfront resort communities.

Set within 35 acres of lush tropical gardens originally designed for Hawaiian royalty, this spacious condo offers a perfect blend of historic charm and modern comfort. Air conditioning throughout ensures comfort, complemented by ceiling fans and tropical breezes.

The king-bedded master suite features a private en-suite bathroom. The second bedroom has a queen bed, and the third offers twin beds - each with its own bathroom. A queen sleeper sofa in the living area provides additional sleeping for two more guests. The fully equipped kitchen, comfortable living area, and dining space create a welcoming home base.

Kiahuna Plantation's grounds are a destination themselves, with manicured gardens, meandering paths, and the resort pool. But the real treasure is the location: walk through the gardens and you're on Poipu Beach, consistently rated one of Hawaii's best.

The on-site restaurant, nearby shops, and Poipu's dining scene are all convenient. Explore Spouting Horn, the National Tropical Botanical Garden, or the dramatic coastline of Maha'ulepu Heritage Trail.`,
        photoFolder: "",
        photos: [],
      },
      {
        id: "prop32-kia-2br",
        unitNumber: "Building 2",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,100",
        maxGuests: 6,
        shortDescription: "Garden view 2BR/2BA condo at Kiahuna Plantation. AC, full kitchen, lanai, and direct access to Poipu Beach. King master and queen second bedroom plus queen sleeper sofa. Resort pool and tropical garden paths.",
        longDescription: `Welcome to this 2-bedroom, 2-bathroom condominium at Kiahuna Plantation in Poipu, set among 35 acres of royal tropical gardens.

This comfortable unit features air conditioning, a full kitchen with modern appliances, and a cozy living area that opens to a lanai overlooking the tropical gardens. The king-bedded master suite has a private en-suite bath, and the queen-bedded second bedroom is adjacent to the second full bath. A queen sleeper sofa in the living area provides additional sleeping for two more guests.

All linens, beach towels, WiFi, and basic kitchen supplies are provided. The resort pool and garden walking paths offer relaxation between beach adventures.

Step through the gardens to reach Poipu Beach for swimming, snorkeling, and sunbathing. Kiahuna's beachfront location on Kauai's south shore guarantees the island's best weather and most consistent sunshine.

Nearby attractions include Spouting Horn blowhole, Allerton Garden, and the scenic Maha'ulepu coastal trail. Poipu's restaurants and shops are just a short walk away.`,
        photoFolder: "",
        photos: [],
      },
    ],
  },
  {
    propertyId: 33,
    propertyName: "Beautiful Poipu Townhomes for 12 with AC! 6 Bedrooms.",
    complexName: "Kiahuna Plantation",
    address: "2253 Poipu Rd, Unit B, Koloa, HI 96756",
    bookingTitle: "Kiahuna Plantation - Sleeps 12 | 6BR Beachfront Garden Condos with AC | Poipu Beach, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of units within Kiahuna Plantation. Individual units may vary in decor, furnishings, and layout.",
    combinedDescription: `This listing is comprised of two spacious 3-bedroom condos within Kiahuna Plantation, Poipu Beach's iconic beachfront resort set among 35 acres of royal tropical gardens. Together they offer 6 bedrooms and can accommodate up to 16 guests, with AC throughout and direct garden-path access to Poipu Beach.

Building 10 is a tropical 3-bedroom, 3-bathroom condo (~1,500 sq ft) with AC, a full kitchen, covered lanai with garden views, and private bathrooms for each bedroom. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa.

Building 26 is a stylish 3-bedroom, 3-bathroom condo (~1,500 sq ft) with a modern aesthetic, AC throughout, a quality kitchen, and a lanai overlooking the resort's spectacular gardens. Sleeps 8 with a King master, Queen second bedroom, Twin third bedroom, and a queen sleeper sofa.

Kiahuna Plantation's beachfront location means Poipu Beach is a garden walk away. Explore the south shore's attractions including Spouting Horn, the National Tropical Botanical Garden, and outstanding snorkeling at Koloa Landing.`,
    hasPhotos: false,
    units: [
      {
        id: "prop33-kia-3br-a",
        unitNumber: "Building 10",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,500",
        maxGuests: 8,
        shortDescription: "Tropical 3BR/3BA condo in Kiahuna Plantation with AC, full kitchen, lanai with garden views, and beachfront access. King master, queen and twin bedrooms plus queen sleeper sofa. Steps to Poipu Beach.",
        longDescription: `Welcome to this 3-bedroom, 3-bathroom condominium at Kiahuna Plantation, nestled within the resort's lush 35-acre tropical gardens on Poipu Beach.

This well-appointed unit features AC throughout, an open floor plan with the living room flowing into the fully equipped kitchen and dining area. The covered lanai provides a peaceful outdoor space surrounded by tropical plants and the resort's beautiful grounds.

Three bedrooms each have their own bathroom: the king-bedded master suite, queen second bedroom, and twin-bedded third room. A queen sleeper sofa in the living area provides additional sleeping for two more guests. All rooms feature ceiling fans and AC for comfort.

The kitchen is fully stocked for home cooking, and the dining area accommodates the whole group. WiFi, cable TV, washer/dryer access, and all linens are provided.

Kiahuna Plantation's beachfront location means Poipu Beach is a garden walk away. The resort pool, restaurant, and gorgeously maintained grounds make this an exceptional Kauai vacation base.

Explore the south shore's attractions including Spouting Horn, the National Tropical Botanical Garden, and outstanding snorkeling at nearby Koloa Landing.`,
        photoFolder: "",
        photos: [],
      },
      {
        id: "prop33-kia-3br-b",
        unitNumber: "Building 26",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,500",
        maxGuests: 8,
        shortDescription: "Stylish 3BR/3BA condo at Kiahuna Plantation. AC, modern kitchen, comfortable bedrooms with private baths, queen sleeper sofa, and lanai overlooking gardens. King, queen, and twin beds. Walk to Poipu Beach.",
        longDescription: `Welcome to this stylish 3-bedroom, 3-bathroom condominium at Kiahuna Plantation, located in the heart of Poipu's most iconic beachfront resort.

Updated with a modern aesthetic while honoring the property's historic Hawaiian heritage, this condo offers comfortable living with AC throughout. The open layout connects the living, dining, and kitchen areas for easy entertaining.

Each bedroom features its own private bathroom. The king-bedded master suite provides a private retreat, while the queen and twin-bedded rooms accommodate additional guests comfortably. A queen sleeper sofa in the living area provides additional sleeping for two more guests. Ceiling fans supplement the AC.

The modern kitchen has quality appliances, ample counter space, and all the essentials for preparing meals. The lanai overlooks the resort's spectacular gardens.

Walk to Poipu Beach through the beautiful resort grounds. The Kiahuna Plantation's 35 acres of tropical gardens, originally landscaped for Hawaiian royalty, create a serene environment unlike any other resort on Kauai.

Poipu's south shore offers year-round sunshine, world-class snorkeling, and the best dining and shopping on Kauai's south coast.`,
        photoFolder: "",
        photos: [],
      },
    ],
  },
  {
    propertyId: 34,
    propertyName: "Wonderful 6 Bedroom For 16 Villa in Poipu!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Bldg 7, Koloa, HI 96756",
    bookingTitle: "Regency at Poipu Kai - Sleeps 16 | 6BR Villa with Pool & Tennis | Poipu, Kauai",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    combinedDescription: `This listing is comprised of two spacious 3-bedroom condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 6 bedrooms and can accommodate up to 15 guests, a wonderful option for groups seeking a sunny south shore Kauai vacation.

Unit 524 is a 3-bedroom, 2.5-bathroom Regency I condo (~1,800 sq ft) with a breakfast bar kitchen, covered lanai, master suite with private bath, and a loft bedroom. Sleeps 8 with a King bed, Queen bed, 2 Twins, and a sofa bed. AC in bedrooms.

Unit 324 is a bright 3-bedroom, 3-bathroom Regency I condo (~1,800 sq ft) with an open-concept design, fully equipped kitchen, garden views, three full baths, and a lanai dining area. Sleeps 7 with a King bed, Queen bed, 2 Twins, and a futon. AC in bedrooms.

All guests enjoy resort amenities including a pool, hot tub, tennis and pickleball courts, and beautifully landscaped tropical gardens. Walk to Poipu Beach Park, Brennecke's Beach, and Shipwreck Beach in about 10 minutes.`,
    hasPhotos: true,
    units: [
      {
        id: "unit-524",
        unitNumber: "524",
        bedrooms: 3,
        bathrooms: "2.5",
        sqft: "~1,800",
        maxGuests: 8,
        shortDescription: "Spacious 3-bedroom, 2.5-bath Regency I condo in building 5 with a breakfast bar kitchen, covered lanai, master suite with private bath, and a loft bedroom. AC in bedrooms. Sleeps 8 with King, Queen, 2 Twins, and a sofa bed.",
        longDescription: `Welcome to Unit 524, a roomy 3-bedroom, 2.5-bathroom condominium in Building 5 of the Regency at Poipu Kai resort. This Regency I unit offers a spacious layout with classic island-style decor and air conditioning in the bedrooms.

The approximately 1,800 sq ft interior features a welcoming open floor plan with a comfortable living area, dedicated dining space, and a well-equipped kitchen with breakfast bar. The covered lanai provides an ideal space for outdoor dining and enjoying the tropical garden surroundings.

The kitchen includes modern appliances, plenty of counter space, and a convenient breakfast bar for casual meals. Everything is fully stocked for preparing your favorite dishes during your Kauai stay.

The master bedroom suite features a King bed with a private en-suite bathroom. The second bedroom offers a Queen bed, while the loft-level third bedroom has 2 Twin beds with its own adjacent half bath. A sofa bed in the living area provides sleeping for an 8th guest. Ceiling fans and bedroom AC keep you comfortable.

Resort amenities are just a short walk away, including a refreshing pool, hot tub, and tennis and pickleball courts set among fragrant tropical gardens. The Regency at Poipu Kai complex is well-maintained and offers a peaceful setting.

From this convenient south shore location, walk to Poipu Beach Park, Brennecke's Beach, and Shipwreck Beach in about 10 minutes. Kauai's sunny Poipu coast offers endless opportunities for snorkeling, surfing, hiking, and dining.`,
        photoFolder: "unit-423",
        photos: PHOTOS_423,
      },
      {
        id: "unit-324",
        unitNumber: "324",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Open-concept 3-bedroom, 3-bath Regency I condo in building 3 with a fully equipped kitchen, garden views, three full baths, and a lanai dining area. AC in bedrooms. Sleeps 7 with King, Queen, 2 Twins, and futon.",
        longDescription: `Welcome to Unit 324, a bright and airy 3-bedroom, 3-bathroom condominium in Building 3 of the Regency at Poipu Kai resort. This Regency I unit features an open-concept design with air conditioning in the bedrooms and ceiling fans throughout.

The approximately 1,800 sq ft layout creates a generous living space with the open-concept design connecting the living room, dining area, and kitchen. Garden views from the main living area and lanai dining area bring the beauty of the tropics indoors.

The fully equipped kitchen has everything you need, from quality appliances to ample counter space and a full complement of cookware and utensils. The lanai dining area is perfect for enjoying meals surrounded by the sights and sounds of the tropical gardens.

Three full bathrooms serve the three bedrooms. The master suite has a King bed and en-suite bath, the second bedroom offers a Queen bed, and the third bedroom features 2 Twin beds. A futon provides additional sleeping. Bedrooms have AC for comfortable nights.

The Regency at Poipu Kai resort amenities are easily accessible, including a pool, hot tub, and tennis and pickleball courts. The beautifully landscaped grounds make every walk through the property a pleasure.

Three of Kauai's best beaches are within a pleasant 10-minute walk. Enjoy the calm waters at Poipu Beach Park, the exciting shore break at Brennecke's Beach, or the spectacular scenery at Shipwreck Beach.`,
        photoFolder: "unit-621",
        photos: PHOTOS_621,
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
