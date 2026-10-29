# OpenBench: project document

## 1. Use case

Sharing lab equipment and rooms inside one engineering college: 3D printers, laser cutters, oscilloscopes, microcontroller kits, cameras, drones, workshop bays and seminar halls. The first deployment is one campus, with departments as the unit of ownership.

## 2. Target users and resource owners

| Who | Role in OpenBench | What they need |
| --- | --- | --- |
| Students and student teams | Users | Find equipment, know what's required, get a clear yes, no or wait, with the reason |
| Lab-in-charges, makerspace and media-cell staff | Owners | Control over who uses their equipment, evidence of its condition, less chasing |
| Heads of department | Managers | Settle disputes fairly, approve exceptions, see who is using what |
| Institution admin | Admin | Verify people, assign roles, see the full record |

## 3. Why the problem matters

- India already treats equipment sharing as policy. The national I-STEM portal lists 30,249 instruments from 3,812 institutions and has generated 88,887 booking requests; a Department of Expenditure order (3 Jul 2025) makes listing publicly funded equipment above ₹20 lakh mandatory ([PSA, I-STEM](https://www.psa.gov.in/CMS/web/i-stem)).
- I-STEM serves researchers booking expensive instruments across institutions. Inside a campus, a student who needs an oscilloscope or a 3D printer for a weekend project usually depends on a paper register, a WhatsApp message, and the lab assistant's memory.
- Commercial tools (Clustermarket/Calira, QReserve, Cheqroom) handle calendars well. None of them combines training-based eligibility, photo condition records at both ends, explainable fair allocation and a student-facing mobile app.
- [Add your own campus survey results here: how many students needed equipment they couldn't get, and what they do today.]

## 4. The solution

OpenBench is a booking system with trust built into the lifecycle:

- **Eligibility before the request.** Each resource lists its requirements: a training certificate, a minimum year, a department, or a link to a registered course. Students see what they meet before they ask. A training belongs to the department that runs it, and only that department's staff can verify certificates for it.
- **Every check shown, live.** While picking a slot, the student sees each automatic check pass or fail, and whether the request will go to review, join the waitlist, or be blocked.
- **People decide.** Owners approve, reject or waitlist with a written reason the student sees. A request that fails a check can only be approved by a department manager, as a recorded override. Nobody can decide their own request.
- **Condition on both ends.** Check-in and return each record the owner's checklist and at least one photo. The owner countersigns when confirming the return.
- **Disputes go up.** Damage, delays and conflicts become incidents that a department manager resolves. A strike is a separate, explicit decision with a reason; three strikes pause booking for 14 days.
- **One register.** Every change is written by the database to an append-only log that both parties can read and nobody can edit.

## 5. Workflow

1. Owner lists a resource with rules, requirements, opening hours, caps and a checklist.
2. Student finds it (search, category, "only what I can book", or describing the job to the AI suggester) and sees their eligibility.
3. Student picks a slot; all checks run live.
4. On submit, the database re-runs the checks: blocked (with the reasons), waitlisted (slot taken) or sent for review.
5. Owner reviews, with the student's usage, history, strikes and an optional AI brief.
6. Approve, reject or waitlist, each with a reason. Approving moves competing requests that no longer fit to the waitlist.
7. Student checks in: checklist, photos, notes.
8. Student returns: checklist, photos, notes. Owner compares and confirms; the booking closes.
9. Late, missing, damaged? An incident is opened (by either party, or automatically for no-shows and overdue returns) and a manager resolves it.
10. Both parties see the full history on the booking page.

## 6. Features built

Web, Android and iOS from one codebase · email sign-in with optional college-domain restriction · admin verification of accounts · training certificates with owner/admin verification and optional AI pre-screen · listings with requirements, opening hours, blackout days, pooled quantities, deposits, supervision flag and checklist · smart search · live eligibility and checks · fair-allocation ranking with explanations · weekly booking and hour caps, cooldown · waitlist with automatic promotion · approve/reject/waitlist with mandatory reasons · manager override · check-in/return with photos · owner countersign · incidents, review, resolution, strikes and suspension · automatic no-show and overdue handling · in-app notifications with live updates, optional email · review queue grouping competing requests · fair-use report per resource · full audit log · demo reset · light and dark themes.

## 7. Technology and architecture

| Layer | Choice |
| --- | --- |
| App | Expo SDK 58, React Native 0.88, Expo Router, TanStack Query, TypeScript |
| Database, auth, storage, realtime | Supabase (Postgres 16) |
| Business rules | Postgres functions, triggers, row-level security, an exclusion constraint |
| Engine API | Python FastAPI on Render |
| AI | Google Gemini API through the engine, with rule-based fallbacks |
| Email | Resend (optional) |
| Hosting | Vercel (web), Render (API), Expo EAS (Android APK, iOS) |
| Scheduling | GitHub Actions every 10 minutes |

The app talks to Supabase directly for reads and for every lifecycle action, through checked database functions. The engine API handles what needs a secret: AI calls, email, the time-based sweep and the demo reset. It always first asks Supabase, with the user's own token, whether the user may act, and only then uses the service key to write the advisory AI field.

## 8. AI tools, APIs and external services

- **Google Gemini** (in the product): request briefs for reviewers, certificate pre-screening (reads name, training and dates from the image), incident summaries comparing check-in and return records, and smart search. All output is labelled advisory, stored next to the record, and never changes a status. If the API is unavailable, deterministic rules produce the same kind of output and say so.
- **Supabase, Vercel, Render, Expo EAS, Resend, GitHub Actions** as listed above.
- **AI in development**: Claude (Anthropic) generated much of the code, tests and documentation.

## 9. Privacy, security and fairness

- Data collected: name, college email, department, year, roll number, certificates, condition and incident photos. No phone numbers, no location.
- Row-level security on every table; the anonymous role has no access at all. Students cannot see each other's bookings, profiles, certificates or photos; other students in a competing queue are hidden from them.
- All lifecycle changes go through database functions that check the caller. Clients have no direct write access to bookings, incidents, condition records or resources.
- Photos and certificates live in private storage buckets, readable only by the people on that booking or those verifying the user, through links that expire in an hour. Upload paths are tied to the uploader and the booking.
- Role, verification and strikes can't be changed by the user; changing name, department, year or roll number sends an account back for verification.
- Check-in and return need photos that were actually uploaded, and the checklist is rebuilt from the owner's template on the server.
- Staff-only fields (AI briefs, incident summaries, other students' ranking facts) are hidden from students at the column level.
- Demo resets only work on a deployment marked as a demo.
- The audit log is written by triggers and can't be read directly, edited or deleted by any app user.
- Double-booking is prevented by a Postgres exclusion constraint; pooled capacity is checked under a row lock.
- Rate limits on requests and reports; the API checks origins, body size and token validity.
- Fairness: weekly caps per person and resource, optional cooldowns, a published ranking rule for clashes (first-time users, then least use this week, then course-linked, then earliest), automatic waitlist promotion, and a usage-concentration report for managers.
- Human oversight: approvals, rejections, overrides, verification, incident resolution and strikes are all made by a named person with a reason.

## 10. Known limitations

- One institution per deployment.
- Deposits are acknowledged, not collected.
- Push notifications on phones are not set up; notifications are in-app (live) and by email.
- No offline mode.
- English only.
- iPhone access is through Expo Go unless an Apple developer account is available.
- Free-tier hosting: the API may take 30 seconds to wake if the scheduled ping has not run.

## 11. Future development

QR labels on equipment so check-in starts with a scan · UPI deposit holds · push notifications · Hindi and other Indian languages · calendar sync · maintenance scheduling from usage hours · credit-based allocation per department · federation across institutions, I-STEM style · a pilot in one department with the lab-in-charges who shaped it.

## 12. Team

| Member | Role | Contribution |
| --- | --- | --- |
| [Name] | [Role] | [What they did] |
