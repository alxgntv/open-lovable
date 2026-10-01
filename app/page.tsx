import ProjectHome from '@/components/app/home/ProjectHome';

// ─── Ariadne's Thread [AT-0087] ─────────────────────
// What: Open / on the Code Market home instead of the builder
// Why:  The first screen is the project home; generation stays at /generation
// Date: 2026-10-01
// Related: [AT-0088] frontend→components/app/home/ProjectHome.tsx:ProjectHome, [AT-0005] app/page.tsx:Page
// ─────────────────────────────────────────────────────
export default function Page() {
  return <ProjectHome />;
}
