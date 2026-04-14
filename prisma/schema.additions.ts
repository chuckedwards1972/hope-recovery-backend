// ═══════════════════════════════════════════════════════════
// POLR SCHEMA ADDITIONS — append to schema.prisma
// These extend the base schema with:
//   - Approval workflow engine
//   - Scoring history
//   - Podcast/Vlog media system
//   - Meeting prep submissions
//   - Campus sustainability index
// ═══════════════════════════════════════════════════════════

// ─── ENUMS (add to schema.prisma) ────────────
// enum WorkflowStatus { PENDING, APPROVED, REJECTED, NEEDS_REVIEW }
// enum WorkflowType { LEADERSHIP_PROMOTION, HOUSING_PLACEMENT, WORKFORCE_CERT, CAMPUS_LAUNCH, DONATION_VERIFICATION, MEDIA_PUBLISH }
// enum MediaType { PODCAST, VLOG, TEACHING, ANNOUNCEMENT }
// enum MediaStatus { DRAFT, PENDING_APPROVAL, PUBLISHED, ARCHIVED }

// ─── APPROVAL WORKFLOWS ──────────────────────
// model ApprovalWorkflow {
//   id           String         @id @default(uuid())
//   type         WorkflowType
//   status       WorkflowStatus @default(PENDING)
//   requesterId  String
//   approverId   String?
//   campusId     String
//   targetId     String?        // id of the thing being approved
//   targetType   String?
//   notes        String?
//   approverNote String?
//   metadata     Json?
//   createdAt    DateTime       @default(now())
//   updatedAt    DateTime       @updatedAt
//   resolvedAt   DateTime?
// }

// ─── SCORING HISTORY ─────────────────────────
// model ScoringHistory {
//   id              String   @id @default(uuid())
//   userId          String
//   engagementScore Int
//   relapseRisk     Int
//   relapseLevel    String
//   leadershipScore Int
//   leadershipReady Boolean
//   certProgress    Int
//   computedAt      DateTime @default(now())
//   triggeredBy     String?  // eventType that triggered recompute
// }

// ─── MEDIA (PODCAST / VLOG) ──────────────────
// model MediaItem {
//   id          String      @id @default(uuid())
//   type        MediaType
//   status      MediaStatus @default(DRAFT)
//   title       String
//   description String?
//   fileUrl     String?
//   thumbnailUrl String?
//   duration    Int?        // seconds
//   tags        String[]
//   campusId    String?     // null = all campuses
//   authorId    String
//   publishedAt DateTime?
//   approvedBy  String?
//   plays       Int         @default(0)
//   createdAt   DateTime    @default(now())
//   updatedAt   DateTime    @updatedAt
// }

// ─── MEETING PREP SUBMISSIONS ────────────────
// model MeetingPrepSubmission {
//   id              String   @id @default(uuid())
//   userId          String
//   meetingId       String
//   campusId        String
//   stepReflection  String?   // "Something I did following the 12 Steps this week"
//   scriptureInsight String?  // "What I learned from last session's scripture"
//   meetingFocus    String?   // "What last meeting's focus helped me understand"
//   sessionReflection String? // "Last session's reflection helped me realize..."
//   identityStatement Boolean @default(false) // confirmed "Faithful Follower" declaration
//   createdAt       DateTime @default(now())
// }

// ─── CAMPUS SUSTAINABILITY INDEX ─────────────
// model CampusSustainabilityIndex {
//   id                    String   @id @default(uuid())
//   campusId              String   @unique
//   attendanceScore       Int      @default(0)  // 0-25
//   donorScore            Int      @default(0)  // 0-25
//   housingScore          Int      @default(0)  // 0-20
//   workforceScore        Int      @default(0)  // 0-15
//   leadershipScore       Int      @default(0)  // 0-15
//   totalScore            Int      @default(0)  // 0-100
//   recommendedLifecycle  String?
//   computedAt            DateTime @default(now())
// }
