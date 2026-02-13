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

export const unitBuilderData: PropertyUnitBuilder[] = [
  {
    propertyId: 1,
    propertyName: "Poipu Kai for large groups!",
    complexName: "Regency at Poipu Kai",
    address: "1831 Poipu Rd, Bldg 8, Koloa, HI 96756",
    bookingTitle: "Regency at Poipu Kai - Sleeps 16 | 7BR Resort Villas with Pool & Tennis | Poipu Beach, Kauai",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
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
        maxGuests: 5,
        shortDescription: "Modern 2-bedroom, 2-bath ground-floor condo in Regency I building 1. Features AC and ceiling fans, a renovated modern kitchen with stainless appliances, two private balconies, and an open floor plan. Sleeps 5 with Queen and King beds.",
        longDescription: `Welcome to Unit 114, a stylishly renovated 2-bedroom, 2-bathroom ground-floor condominium in Building 1 of the Regency at Poipu Kai resort on Kauai's coveted south shore.

This approximately 1,250 sq ft condo has been thoughtfully updated with a modern aesthetic while maintaining its warm island charm. The open floor plan creates a spacious feel, with the living room flowing into the dining area and kitchen. Air conditioning and ceiling fans keep you comfortable year-round.

The modern kitchen features sleek stainless steel appliances, ample counter space, and is fully stocked with everything you need for home-cooked meals. Two private balconies provide outdoor living space to enjoy the tropical breezes and garden views.

The primary bedroom features a comfortable Queen bed with its own renovated en-suite bathroom with dual sinks. The second bedroom offers a King bed and is adjacent to the second full bathroom, also beautifully renovated. A convenient work area is available for those who need to stay connected.

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
        maxGuests: 4,
        shortDescription: "Comfortable 2-bedroom, 2-bath Regency II condo in building 9 with central AC throughout. Features King beds in both rooms, a fully stocked kitchen, large dining area, private covered lanai, and smart TVs. Sleeps 4.",
        longDescription: `Welcome to Unit 911, a well-appointed 2-bedroom, 2-bathroom condominium in Building 9 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning throughout for your complete comfort on Kauai's sunny south shore.

The approximately 1,250 sq ft interior offers a thoughtfully designed layout with a spacious living area, large dining area that seats the whole party, and a private covered lanai perfect for al fresco dining or simply soaking in the tropical garden views. Smart TVs in the living area and bedrooms provide entertainment options.

The fully stocked kitchen includes modern appliances, generous counter space, and all the cookware and utensils needed for everything from quick breakfasts to full dinners. The open layout connects the kitchen to the dining and living spaces for easy socializing.

The master bedroom features a plush King bed, smart TV, and en-suite bathroom with a soaking tub and separate shower. The second bedroom also offers a comfortable King bed and is adjacent to the second full bathroom, ideal for couples traveling together.

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
    bookingTitle: "Regency at Poipu Kai - Spacious 6BR Villa with Pool and Tennis in Sunny Poipu, Kauai",
    sampleDisclaimer: DEFAULT_DISCLAIMER,
    hasPhotos: true,
    units: [
      {
        id: "unit-423",
        unitNumber: "423",
        bedrooms: 3,
        bathrooms: "2.5",
        sqft: "~1,800",
        maxGuests: 8,
        shortDescription: "Spacious 3-bedroom, 2.5-bath condo at the Regency at Poipu Kai resort. Features a covered dining lanai, open-plan living with great room, fully equipped kitchen with breakfast bar, master suite with private lanai and en-suite bath, plus two additional guest bedrooms including a loft. Steps to pool, tennis courts, and three Poipu beaches.",
        longDescription: `Welcome to this beautifully appointed 3-bedroom, 2.5-bathroom condominium at the prestigious Regency at Poipu Kai resort on Kauai's sunny south shore.

This spacious approximately 1,800 sq ft condo features an inviting open floor plan with a generous great room that flows seamlessly from the living area through the dining space to the fully equipped kitchen. The covered dining lanai is perfect for enjoying tropical breezes and morning coffee.

The kitchen boasts modern appliances, ample counter space, and a breakfast bar for casual dining. The main living area offers comfortable seating with direct lanai access and abundant natural light.

The master bedroom suite includes a private lanai, walk-in closet, and en-suite bathroom with separate shower. The second guest bedroom provides a comfortable retreat, while the third bedroom is a charming open loft space with its own adjacent bath.

Located within the Regency at Poipu Kai complex, guests enjoy access to resort amenities including swimming pool, tennis courts, and beautifully maintained tropical gardens. The property is just steps from three stunning Poipu beaches including Shipwreck Beach and Poipu Beach Park.

The complex is ideally situated near shops, restaurants, and the Poipu Athletic Club. Whether you are looking to surf, snorkel, hike, or simply relax, this condo offers the perfect home base for your Kauai vacation.`,
        photoFolder: "unit-423",
        photos: [
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
          { filename: "11-master-bath.jpg", label: "Master Bedroom Suite Bath", category: "Bathrooms" },
          { filename: "12-master-bath-shower.jpg", label: "Master Bedroom Suite Bath and Shower", category: "Bathrooms" },
          { filename: "13-second-guest-bedroom.jpg", label: "Second Guest Bedroom", category: "Bedrooms" },
          { filename: "14-third-bedroom-loft.jpg", label: "Third Guest Bedroom Open Loft", category: "Bedrooms" },
          { filename: "15-third-bedroom-loft-bath.jpg", label: "Third Guest Bedroom Open Loft and Bath", category: "Bathrooms" },
          { filename: "16-guest-shared-bath.jpg", label: "Second Guest Shared Bath", category: "Bathrooms" },
          { filename: "17-guest-half-bath.jpg", label: "Guest Half Bath", category: "Bathrooms" },
        ],
      },
      {
        id: "unit-621",
        unitNumber: "621",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 8,
        shortDescription: "Beautiful 3-bedroom, 3-bath condo at the Regency at Poipu Kai resort. Features garden views from the living room and lanai, open-concept kitchen with breakfast bar, primary bedroom suite with private lanai and en-suite bath with walk-in shower, plus two additional guest bedrooms each with their own bath. Steps to pool, tennis courts, and three Poipu beaches.",
        longDescription: `Welcome to this stunning 3-bedroom, 3-bathroom condominium at the sought-after Regency at Poipu Kai resort on Kauai's beautiful south shore.

This approximately 1,800 sq ft condo offers a light-filled open floor plan with lovely garden views from the main living area and lanai. The spacious great room seamlessly connects the living, dining, and kitchen areas for an ideal entertaining layout.

The fully equipped kitchen features modern appliances, generous counter space, and a breakfast bar perfect for casual meals. The open layout allows the cook to stay connected with family and guests while preparing meals.

The primary bedroom suite is a true retreat, featuring a private lanai overlooking the gardens, an en-suite bathroom with walk-in shower, and ample closet space. The second guest bedroom also enjoys garden views and has its own adjacent bathroom. The third bedroom is located in an upper loft area with its own bath, providing additional privacy.

Guests enjoy full access to the Regency at Poipu Kai resort amenities including a swimming pool, tennis courts, and lushly landscaped tropical gardens. The complex is a short walk to three of Poipu's finest beaches, including world-famous Poipu Beach Park and Shipwreck Beach.

Located on Kauai's sunny south shore, the area offers excellent dining, shopping, snorkeling, surfing, and hiking opportunities. This condo is perfectly positioned for experiencing the best of Kauai.`,
        photoFolder: "unit-621",
        photos: [
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
          { filename: "11-primary-bath.jpg", label: "Primary Bedroom Suite Bath", category: "Bathrooms" },
          { filename: "12-primary-bath-shower.jpg", label: "Primary Bedroom Suite Bath and Shower", category: "Bathrooms" },
          { filename: "13-second-guest-bedroom-garden.jpg", label: "Second Guest Bedroom and Garden View", category: "Bedrooms" },
          { filename: "14-second-guest-bedroom.jpg", label: "Second Guest Bedroom", category: "Bedrooms" },
          { filename: "15-second-guest-bath.jpg", label: "Second Guest Bedroom Bath", category: "Bathrooms" },
          { filename: "16-third-bedroom-loft.jpg", label: "Third Guest Bedroom Loft", category: "Bedrooms" },
          { filename: "17-third-bedroom-loft-bath.jpg", label: "Third Guest Bedroom Loft and Bath", category: "Bathrooms" },
          { filename: "18-third-bedroom-bath.jpg", label: "Third Guest Bedroom Bath", category: "Bathrooms" },
        ],
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
    hasPhotos: true,
    units: [
      {
        id: "unit-721",
        unitNumber: "721",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 6,
        shortDescription: "Charming 3-bedroom, 3-bath Regency II condo in building 7 with Hawaiian-style furnishings, granite kitchen, and central AC. Features a jetted tub, walk-in marble shower, garden views, and a private balcony. Sleeps 6 with King, Queen, and 2 Twin beds.",
        longDescription: `Welcome to Unit 721, a tastefully decorated 3-bedroom, 3-bathroom condominium in Building 7 of the Regency at Poipu Kai resort. This Regency II unit boasts central air conditioning and authentic Hawaiian-style furniture that captures the spirit of the islands.

The approximately 1,800 sq ft interior features a welcoming open layout with the living room flowing into a spacious dining area and well-appointed kitchen. Granite countertops, modern appliances, and ample prep space make cooking a pleasure. A private balcony offers serene garden views and fresh tropical air.

Step into the master suite to find a luxurious King bed and a spa-inspired en-suite bathroom featuring a jetted soaking tub and walk-in marble shower. The second bedroom provides a restful Queen bed, while the third bedroom is outfitted with 2 Twin beds, ideal for children or friends.

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
        maxGuests: 4,
        shortDescription: "Well-appointed 2-bedroom, 2-bath ground-floor Regency II condo in building 8 with central AC, King beds in both rooms, a full kitchen, garden views, and a private lanai. Sleeps 4.",
        longDescription: `Welcome to Unit 811, a comfortable 2-bedroom, 2-bathroom ground-floor condominium in Building 8 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning throughout, ensuring cool comfort on even the warmest Kauai days.

The approximately 1,250 sq ft layout is thoughtfully designed with an open living and dining area that connects to the fully equipped kitchen. Sliding doors open to a private lanai with peaceful garden views, bringing the outside in. Smart TVs are available for entertainment.

The kitchen comes fully stocked with modern appliances, cookware, and utensils for preparing anything from tropical smoothies to multi-course dinners. A generous dining area provides space for the whole group to gather over meals.

Both bedrooms feature luxurious King beds for a restful night's sleep. The master bedroom has its own en-suite bathroom, while the second bedroom is adjacent to the second full bath. The ground-floor location provides easy access to the pool and gardens.

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
    bookingTitle: "Private Kekaha Beachfront Estate - 5BR Home with Direct Beach Access on Kauai's West Shore",
    sampleDisclaimer: "Photos shown are representative samples of this beachfront estate. The main house and guest quarters may vary in decor and furnishings from photos shown.",
    hasPhotos: false,
    units: [
      {
        id: "prop10-unit-a",
        unitNumber: "Main House",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~1,800",
        maxGuests: 8,
        shortDescription: "Placeholder for main house. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop10-unit-b",
        unitNumber: "Guest Quarters",
        bedrooms: 2,
        bathrooms: "1",
        sqft: "~800",
        maxGuests: 7,
        shortDescription: "Placeholder for guest quarters. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
    ],
  },
  {
    propertyId: 12,
    propertyName: "Incredible Kekaha Beachfront Estate for 10!",
    complexName: "Kekaha Beachfront Estate",
    address: "8515 Kekaha Rd, Kekaha, HI 96752",
    bookingTitle: "Incredible Kekaha Beachfront Estate - 5BR Home with Ocean Views on Kauai's Sunny West Shore",
    sampleDisclaimer: "Photos shown are representative samples of this beachfront estate. The main house and guest quarters may vary in decor and furnishings from photos shown.",
    hasPhotos: false,
    units: [
      {
        id: "prop12-unit-a",
        unitNumber: "Main House",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~1,600",
        maxGuests: 6,
        shortDescription: "Placeholder for main house. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop12-unit-b",
        unitNumber: "Guest Quarters",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~800",
        maxGuests: 4,
        shortDescription: "Placeholder for guest quarters. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
    ],
  },
  {
    propertyId: 14,
    propertyName: "Fabulous 7 br 22 ocean view pool estate!",
    complexName: "Keauhou Estates",
    address: "78-6855 Ali'i Dr, Kailua-Kona, HI 96740",
    bookingTitle: "Keauhou Ocean View Pool Estate - Luxurious 7BR Home with Pool near Kona Coast, Big Island",
    sampleDisclaimer: "Photos shown are representative samples of this estate property. The main house and guest quarters may vary in decor and furnishings from photos shown.",
    hasPhotos: false,
    units: [
      {
        id: "prop14-unit-a",
        unitNumber: "Main House",
        bedrooms: 5,
        bathrooms: "3",
        sqft: "~3,000",
        maxGuests: 14,
        shortDescription: "Placeholder for main house. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop14-unit-b",
        unitNumber: "Guest Quarters",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,000",
        maxGuests: 8,
        shortDescription: "Placeholder for guest quarters. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
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
    propertyName: "Fabulous 5 bedroom for 10 townhome above Anini Beach!",
    complexName: "Mauna Kai at Princeville",
    address: "3920 Wyllie Rd, Princeville, HI 96722",
    bookingTitle: "Mauna Kai Princeville - 5BR Townhomes above Famous Anini Beach with Ocean Views, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of townhome units within Mauna Kai at Princeville. Individual units may vary in decor, furnishings, and layout.",
    hasPhotos: false,
    units: [
      {
        id: "prop19-unit-a",
        unitNumber: "TBD",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~1,400",
        maxGuests: 6,
        shortDescription: "Placeholder for 3-bedroom townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop19-unit-b",
        unitNumber: "TBD",
        bedrooms: 2,
        bathrooms: "1",
        sqft: "~1,000",
        maxGuests: 4,
        shortDescription: "Placeholder for 2-bedroom townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
    ],
  },
  {
    propertyId: 20,
    propertyName: "Fabulous 7 bedrooms for 16 above Anini Beach!",
    complexName: "Mauna Kai at Princeville",
    address: "3920 Wyllie Rd, Unit B, Princeville, HI 96722",
    bookingTitle: "Mauna Kai Princeville - Fabulous 7BR Townhomes above Anini Beach with Ocean Views, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of townhome units within Mauna Kai at Princeville. Individual units may vary in decor, furnishings, and layout.",
    hasPhotos: false,
    units: [
      {
        id: "prop20-unit-a",
        unitNumber: "TBD",
        bedrooms: 3,
        bathrooms: "2",
        sqft: "~1,400",
        maxGuests: 6,
        shortDescription: "Placeholder for 3-bedroom townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop20-unit-b",
        unitNumber: "TBD",
        bedrooms: 2,
        bathrooms: "1.5",
        sqft: "~1,000",
        maxGuests: 5,
        shortDescription: "Placeholder for 2-bedroom townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop20-unit-c",
        unitNumber: "TBD",
        bedrooms: 2,
        bathrooms: "1.5",
        sqft: "~1,000",
        maxGuests: 5,
        shortDescription: "Placeholder for 2-bedroom townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
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
        maxGuests: 4,
        shortDescription: "Modern 2-bedroom, 2-bath Regency II condo in building 9 with central AC, King beds in both rooms, stainless steel kitchen, and a private lanai. Sleeps 4.",
        longDescription: `Welcome to Unit 914, a sleek and modern 2-bedroom, 2-bathroom condominium in Building 9 of the Regency at Poipu Kai resort. This Regency II unit features central air conditioning and tasteful contemporary updates throughout.

The approximately 1,250 sq ft layout is efficiently designed with an open living area that connects to the kitchen and dining space. A private lanai offers a quiet retreat with views of the tropical gardens. Smart TVs are available in the living area and bedrooms.

The updated kitchen features stainless steel appliances, modern finishes, and is fully stocked for meal preparation. The dining area provides ample seating for your group, and the open layout keeps everyone connected.

Both bedrooms feature plush King beds for maximum sleeping comfort. The master bedroom includes an en-suite bathroom, while the second bedroom is adjacent to the second full bath. Modern updates in both bathrooms include contemporary fixtures and finishes.

Resort amenities including the swimming pool, hot tub, and tennis and pickleball courts are just a short walk from your door. The tropical gardens and well-maintained grounds create a peaceful resort atmosphere.

Kauai's famous south shore beaches are a leisurely 10-minute walk from the complex. Enjoy world-class snorkeling at Poipu Beach Park, exciting body surfing at Brennecke's Beach, or peaceful sunset views from Shipwreck Beach.`,
        photoFolder: "unit-911",
        photos: PHOTOS_911,
      },
    ],
  },
  {
    propertyId: 23,
    propertyName: "Gorgeous 5 br for 12 in Kapaa - Beachfront!",
    complexName: "Kapaa Beachfront Townhomes",
    address: "4-820 Kuhio Hwy, Kapaa, HI 96746",
    bookingTitle: "Kapaa Beachfront Townhomes - Gorgeous 5BR Oceanfront Retreat on Kauai's Coconut Coast",
    sampleDisclaimer: "Photos shown are representative samples of townhome units within this beachfront complex. Individual units may vary in decor, furnishings, and layout.",
    hasPhotos: false,
    units: [
      {
        id: "prop23-unit-a",
        unitNumber: "TBD",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,500",
        maxGuests: 7,
        shortDescription: "Placeholder for 3-bedroom oceanfront townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop23-unit-b",
        unitNumber: "TBD",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,100",
        maxGuests: 4,
        shortDescription: "Placeholder for 2-bedroom oceanfront townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
    ],
  },
  {
    propertyId: 24,
    propertyName: "Wonderful 5 br 12 Poipu ocean view! Oceanfront complex!",
    complexName: "Poipu Oceanfront Resort",
    address: "1775 Pe'e Rd, Koloa, HI 96756",
    bookingTitle: "Poipu Oceanfront Resort - 5BR Ocean View Condos in Oceanfront Complex, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of units within this oceanfront complex. Individual units may vary in decor, furnishings, and layout.",
    hasPhotos: false,
    units: [
      {
        id: "prop24-unit-a",
        unitNumber: "TBD",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,500",
        maxGuests: 8,
        shortDescription: "Placeholder for 3-bedroom ocean view unit. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop24-unit-b",
        unitNumber: "TBD",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,100",
        maxGuests: 4,
        shortDescription: "Placeholder for 2-bedroom ocean view unit. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
    ],
  },
  {
    propertyId: 26,
    propertyName: "Fabulous 7 bedroom for 23 near Magic Sands Beach!",
    complexName: "Keauhou Estates",
    address: "78-6920 Ali'i Dr, Kailua-Kona, HI 96740",
    bookingTitle: "Keauhou Estate - Fabulous 7BR Home with Pool near Magic Sands Beach, Big Island Hawaii",
    sampleDisclaimer: "Photos shown are representative samples of this estate property. The main house and guest quarters may vary in decor and furnishings from photos shown.",
    hasPhotos: false,
    units: [
      {
        id: "prop26-unit-a",
        unitNumber: "Main House",
        bedrooms: 5,
        bathrooms: "3",
        sqft: "~3,200",
        maxGuests: 15,
        shortDescription: "Placeholder for main house. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop26-unit-b",
        unitNumber: "Guest Quarters",
        bedrooms: 2,
        bathrooms: "1",
        sqft: "~800",
        maxGuests: 8,
        shortDescription: "Placeholder for guest quarters. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
    ],
  },
  {
    propertyId: 28,
    propertyName: "Beautiful ocean view Poipu 7 brs for 17! 60 yards to Beach!",
    complexName: "Poipu Brenneckes Beachside",
    address: "2298 Ho'one Rd, Koloa, HI 96756",
    bookingTitle: "Poipu Beachside - Beautiful 7BR Ocean View Homes 60 Yards to Brennecke's Beach, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of these beachside homes. Individual homes may vary in decor, furnishings, and layout.",
    hasPhotos: false,
    units: [
      {
        id: "prop28-unit-a",
        unitNumber: "Home A",
        bedrooms: 4,
        bathrooms: "3",
        sqft: "~2,200",
        maxGuests: 10,
        shortDescription: "Placeholder for 4-bedroom home. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop28-unit-b",
        unitNumber: "Home B",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,800",
        maxGuests: 7,
        shortDescription: "Placeholder for 3-bedroom home. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
    ],
  },
  {
    propertyId: 29,
    propertyName: "Ocean view 7 bedrooms for 14 above Anini Beach!",
    complexName: "Kaiulani of Princeville",
    address: "4100 Queen Emma's Dr, Princeville, HI 96722",
    bookingTitle: "Kaiulani of Princeville - 7BR Ocean View Townhomes above Anini Beach, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of townhome units within Kaiulani of Princeville. Individual units may vary in decor, furnishings, and layout.",
    hasPhotos: false,
    units: [
      {
        id: "prop29-unit-a",
        unitNumber: "TBD",
        bedrooms: 4,
        bathrooms: "2.5",
        sqft: "~1,800",
        maxGuests: 8,
        shortDescription: "Placeholder for 4-bedroom townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop29-unit-b",
        unitNumber: "TBD",
        bedrooms: 3,
        bathrooms: "1.5",
        sqft: "~1,400",
        maxGuests: 6,
        shortDescription: "Placeholder for 3-bedroom townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
    ],
  },
  {
    propertyId: 31,
    propertyName: "Fabulous 7 bedroom for 14 oceanfront Poipu pool home!",
    complexName: "Poipu Brenneckes Oceanfront",
    address: "2350 Ho'one Rd, Koloa, HI 96756",
    bookingTitle: "Poipu Oceanfront Pool Home - Fabulous 7BR Estate with Pool Steps to Beach, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of this oceanfront estate. The main house and guest quarters may vary in decor and furnishings from photos shown.",
    hasPhotos: false,
    units: [
      {
        id: "prop31-unit-a",
        unitNumber: "Main Home",
        bedrooms: 5,
        bathrooms: "3",
        sqft: "~3,000",
        maxGuests: 10,
        shortDescription: "Placeholder for 5-bedroom main home. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop31-unit-b",
        unitNumber: "Guest Quarters",
        bedrooms: 2,
        bathrooms: "1",
        sqft: "~800",
        maxGuests: 4,
        shortDescription: "Placeholder for 2-bedroom guest quarters. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
    ],
  },
  {
    propertyId: 32,
    propertyName: "Gorgeous Poipu Townhomes for 12 with AC! 5 Bedrooms.",
    complexName: "Kiahuna Plantation",
    address: "2253 Poipu Rd, Unit A, Koloa, HI 96756",
    bookingTitle: "Kiahuna Plantation - Gorgeous 5BR Beachfront Townhomes with AC in Poipu, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of townhome units within Kiahuna Plantation. Individual units may vary in decor, furnishings, and layout.",
    hasPhotos: false,
    units: [
      {
        id: "prop32-unit-a",
        unitNumber: "TBD",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,500",
        maxGuests: 7,
        shortDescription: "Placeholder for 3-bedroom townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop32-unit-b",
        unitNumber: "TBD",
        bedrooms: 2,
        bathrooms: "2",
        sqft: "~1,100",
        maxGuests: 5,
        shortDescription: "Placeholder for 2-bedroom townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
    ],
  },
  {
    propertyId: 33,
    propertyName: "Beautiful Poipu Townhomes for 12 with AC! 6 Bedrooms.",
    complexName: "Kiahuna Plantation",
    address: "2253 Poipu Rd, Unit B, Koloa, HI 96756",
    bookingTitle: "Kiahuna Plantation - Beautiful 6BR Beachfront Townhomes with AC in Poipu, Kauai",
    sampleDisclaimer: "Photos shown are representative samples of townhome units within Kiahuna Plantation. Individual units may vary in decor, furnishings, and layout.",
    hasPhotos: false,
    units: [
      {
        id: "prop33-unit-a",
        unitNumber: "TBD",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,500",
        maxGuests: 6,
        shortDescription: "Placeholder for 3-bedroom townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
      },
      {
        id: "prop33-unit-b",
        unitNumber: "TBD",
        bedrooms: 3,
        bathrooms: "3",
        sqft: "~1,500",
        maxGuests: 6,
        shortDescription: "Placeholder for 3-bedroom townhome. Details to be added.",
        longDescription: "Full description to be added once unit is identified and verified not on Booking.com or VRBO.",
        photos: [],
        photoFolder: "",
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
