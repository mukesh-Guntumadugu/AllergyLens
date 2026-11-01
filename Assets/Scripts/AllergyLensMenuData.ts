// AllergyLensMenuData — the hard-coded stand-in for what the real product would
// read off a restaurant menu with the camera (see devpost/design-brief.md,
// "Stand-in for the preview"). Owns: the six dishes, their ingredients, and the
// profile items a user can toggle. Expects no @inputs (pure data). Must not
// touch the scene or make UI decisions.

/** One thing a user can flag in their profile. `id` is the key used by dish ingredients. */
export interface ProfileItem {
  id: string
  /** Toggle label shown on the profile panel. */
  label: string
  group: "Allergies" | "Religious" | "Fitness"
}

/** One ingredient line on a dish, as the real product would extract it. */
export interface Ingredient {
  /** Matches ProfileItem.id. */
  id: string
  /** Human name used on the detail card ("peanuts", "beef"). */
  name: string
  /** Can the kitchen leave it out? */
  canLeaveOut: boolean
  /** Short reason when it can't be removed ("peanut butter base"). */
  note?: string
}

export interface Dish {
  id: string
  name: string
  /** Icon file name under Assets/Icons (without .png). */
  icon: string
  ingredients: Ingredient[]
}

export const PROFILE_ITEMS: ProfileItem[] = [
  {id: "peanuts", label: "Peanuts", group: "Allergies"},
  {id: "milk", label: "Milk", group: "Allergies"},
  {id: "eggs", label: "Eggs", group: "Allergies"},
  {id: "shellfish", label: "Shellfish", group: "Allergies"},
  {id: "gluten", label: "Gluten", group: "Allergies"},
  {id: "soy", label: "Soy", group: "Allergies"},
  {id: "beef", label: "I don't eat beef", group: "Religious"},
  {id: "pork", label: "I don't eat pork", group: "Religious"},
  {id: "transfat", label: "Avoid trans fat", group: "Fitness"},
  {id: "sugar", label: "Avoid high sugar", group: "Fitness"},
]

/**
 * Six dishes, two columns on the menu card. Order here is the order on the card
 * (row-major). Two peanut dishes (Thai Peanut Noodles, Peanut Butter Cheesecake)
 * and one beef dish (Classic Beef Burger) satisfy Done criteria 2 and 3.
 */
export const DISHES: Dish[] = [
  {
    id: "noodles",
    name: "Thai Peanut Noodles",
    icon: "ramen_dining",
    ingredients: [
      {id: "peanuts", name: "peanuts", canLeaveOut: true},
      {id: "gluten", name: "wheat noodles", canLeaveOut: false, note: "noodle base"},
      {id: "soy", name: "soy sauce", canLeaveOut: true},
      {id: "eggs", name: "egg", canLeaveOut: true},
    ],
  },
  {
    id: "burger",
    name: "Classic Beef Burger",
    icon: "lunch_dining",
    ingredients: [
      {id: "beef", name: "beef", canLeaveOut: false, note: "beef patty"},
      {id: "gluten", name: "bun", canLeaveOut: true},
      {id: "milk", name: "cheese", canLeaveOut: true},
      {id: "transfat", name: "fried onions", canLeaveOut: true},
    ],
  },
  {
    id: "salmon",
    name: "Grilled Salmon & Greens",
    icon: "set_meal",
    ingredients: [],
  },
  {
    id: "pizza",
    name: "Margherita Pizza",
    icon: "local_pizza",
    ingredients: [
      {id: "milk", name: "mozzarella", canLeaveOut: false, note: "cheese base"},
      {id: "gluten", name: "wheat crust", canLeaveOut: false, note: "crust"},
    ],
  },
  {
    id: "ricebowl",
    name: "Pork Belly Rice Bowl",
    icon: "rice_bowl",
    ingredients: [
      {id: "pork", name: "pork belly", canLeaveOut: false, note: "main protein"},
      {id: "soy", name: "soy glaze", canLeaveOut: true},
      {id: "eggs", name: "fried egg", canLeaveOut: true},
    ],
  },
  {
    id: "cheesecake",
    name: "Peanut Butter Cheesecake",
    icon: "cake",
    ingredients: [
      {id: "peanuts", name: "peanuts", canLeaveOut: false, note: "peanut butter"},
      {id: "milk", name: "cream cheese", canLeaveOut: false, note: "cheesecake base"},
      {id: "eggs", name: "egg", canLeaveOut: false},
      {id: "gluten", name: "biscuit crust", canLeaveOut: true},
      {id: "sugar", name: "sugar", canLeaveOut: false},
    ],
  },
]
