/**
 * Shared Framer Motion variants.
 *
 * One vocabulary for the whole app, so a modal and a toast feel like they
 * belong to the same product. The brief is "subtle": short durations, small
 * distances, no bounce on anything the user sees often. Overshoot is reserved
 * for the modal, which is deliberate and infrequent.
 *
 * Distances are kept under ~12px — enough to read as motion, not enough to
 * feel like the layout is jumping.
 */

/** Standard easing — matches the CSS --transition curve. */
export const EASE = [0.4, 0, 0.2, 1];

/** Page-level transition, keyed on route. */
export const pageVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE } },
  exit:    { opacity: 0, y: -6, transition: { duration: 0.14, ease: EASE } },
};

/**
 * Container that reveals children one after another.
 * staggerChildren is small on purpose: with 12 table rows a 0.05s stagger
 * already takes 0.6s to finish, which starts to feel slow.
 */
export const listContainer = {
  initial: {},
  animate: { transition: { staggerChildren: 0.035, delayChildren: 0.02 } },
};

/** Child of listContainer — table rows, cards, KPI tiles. */
export const listItem = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE } },
};

/** Modal backdrop — plain fade, nothing clever behind the content. */
export const backdropVariants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.16, ease: EASE } },
  exit:    { opacity: 0, transition: { duration: 0.13, ease: EASE } },
};

/** Modal panel — a touch of spring so it feels physical, not linear. */
export const modalVariants = {
  initial: { opacity: 0, scale: 0.97, y: 8 },
  animate: {
    opacity: 1, scale: 1, y: 0,
    transition: { type: 'spring', stiffness: 380, damping: 30, mass: 0.7 },
  },
  exit: { opacity: 0, scale: 0.98, y: 4, transition: { duration: 0.12, ease: EASE } },
};

/** Toast — enters from the right edge it is anchored to. */
export const toastVariants = {
  initial: { opacity: 0, x: 24, scale: 0.97 },
  animate: {
    opacity: 1, x: 0, scale: 1,
    transition: { type: 'spring', stiffness: 420, damping: 34, mass: 0.6 },
  },
  exit: { opacity: 0, x: 16, scale: 0.97, transition: { duration: 0.15, ease: EASE } },
};

/** Login card — slightly longer, it is the first thing anyone sees. */
export const cardVariants = {
  initial: { opacity: 0, y: 14, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.35, ease: EASE } },
};

/** Interactive lift for clickable cards. Paired with a CSS box-shadow change. */
export const hoverLift = {
  whileHover: { y: -2, transition: { duration: 0.16, ease: EASE } },
  whileTap:   { y: 0, scale: 0.995 },
};
