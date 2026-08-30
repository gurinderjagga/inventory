/**
 * Icon vocabulary.
 *
 * Every icon in the app comes from here, so a concept keeps one glyph
 * everywhere and the set can be swapped in a single place. Named for what they
 * mean (IconCompany) rather than what they draw (Building2), so re-theming does
 * not require touching call sites.
 *
 * Replaces the Bootstrap Icons webfont, which was a render-blocking CDN request
 * and a third-party runtime dependency. Lucide ships as tree-shaken SVG
 * components, so only what is imported is bundled.
 */
import {
  LayoutDashboard, Building2, Package, ReceiptText, Users as UsersIcon,
  LogOut, KeyRound, User, UserPlus, Lock, ShieldCheck,
  Search, Plus, PlusCircle, Pencil, Trash2,
  Check, CheckCheck, CheckCircle2, X, XCircle,
  AlertTriangle, AlertCircle, Info,
  Eye, FileDown, FilePlus2, ArrowLeft, ArrowUpCircle, ChevronRight,
  Boxes, Clock,
} from 'lucide-react';

/* Navigation & entities */
export const IconDashboard = LayoutDashboard;
export const IconCompany   = Building2;
export const IconStock     = Package;
export const IconInvoice   = ReceiptText;
export const IconUsers     = UsersIcon;
export const IconBrand     = Boxes;

/* Account */
export const IconLogout    = LogOut;
export const IconKey       = KeyRound;
export const IconUser      = User;
export const IconUserPlus  = UserPlus;
export const IconLock      = Lock;
export const IconShield    = ShieldCheck;

/* Actions */
export const IconSearch     = Search;
export const IconPlus       = Plus;
export const IconPlusCircle = PlusCircle;
export const IconEdit       = Pencil;
export const IconDelete     = Trash2;
export const IconView       = Eye;
export const IconPdf        = FileDown;
export const IconNewInvoice = FilePlus2;
export const IconFinalize   = CheckCheck;
export const IconBack       = ArrowLeft;
export const IconUp         = ArrowUpCircle;
export const IconChevron    = ChevronRight;
export const IconClose      = X;

/* Status */
export const IconCheck    = Check;
export const IconSuccess  = CheckCircle2;
export const IconError    = XCircle;
export const IconWarning  = AlertTriangle;
export const IconAlert    = AlertCircle;
export const IconInfo     = Info;
export const IconPending  = Clock;

/**
 * Default sizing. Lucide defaults to 24px, which is oversized next to 13.5px
 * body text; 16 sits correctly on a line of text and 14 inside small buttons.
 */
export const ICON_SM = 13;
export const ICON_MD = 15;
export const ICON_LG = 18;
