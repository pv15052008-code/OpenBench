# Testing guide for judges

Open the web app link. On the sign-in page, click any demo account to sign in. All accounts are fictional and share one password: **OpenBench@2026**.

| Account | Role | Use it to |
| --- | --- | --- |
| Aarav Singh, `aarav@demo.openbench.in` | Student, ECE 3rd year | Book, check in, return |
| Prof. Vikram Mehta, `prof.mehta@demo.openbench.in` | Owner, Fabrication Lab (ME) | Review requests, verify training, confirm returns |
| Prof. R. Sharma, `hod.sharma@demo.openbench.in` | Manager, ME department | Resolve incidents, approve with override, audit log |
| Dr. Neha Iyer, `admin@demo.openbench.in` | Admin | Verify accounts, change roles, full audit log, reset demo |
| Kabir Nair, `kabir@demo.openbench.in` | Student, CSE 2nd year | First-time printer user in a competing request |
| Isha Verma, `isha@demo.openbench.in` | Student, ME 2nd year | Heavy printer user with one strike |
| Dr. Anjali Rao, `dr.rao@demo.openbench.in` | Owner, Electronics Lab | Oscilloscope and pooled Arduino kits |
| Ms. Tara Kapoor, `ms.kapoor@demo.openbench.in` | Owner, Media Cell | Camera return waiting for confirmation |

Switch accounts quickly from **Me → Switch demo account**.

## The full journey (about 6 minutes)

1. **Aarav**: Explore → *Prusa MK4 3D Printer*. The eligibility panel says the 3D printing induction is missing.
2. **Aarav**: Choose a time → pick *Now* → write a purpose → accept the filament charge. The live checks show the request would be blocked and why. Send it: it's recorded as *Blocked* with the failed rule.
3. **Aarav**: Me → Upload a certificate → choose *3D printing safety induction* → add any photo → Send for verification.
4. **Prof. Mehta**: Verify → the certificate is listed (optional: AI pre-screen) → Verify, with a reason.
5. **Aarav**: book the printer again for *Now*. Every check is green; send. (The earlier blocked request is retired automatically.)
6. **Prof. Mehta**: Review → open the request → *Write brief* → Approve with a reason.
7. **Aarav**: Bookings → the printer → Check in: mark each checklist item, add a photo, record. Then *Return it*, marking one item *Not OK* with a note.
8. **Prof. Mehta**: open the booking → compare the before and after photos → Confirm return. Or *Report a problem* to start a dispute.
9. Scroll to **Register** on the booking: every step, who did it, when and why. Aarav sees the same record.

## Fair allocation

As **Prof. Mehta**, open **Review**. Two students want the printer tomorrow 15:00–17:00. Kabir (first-time user, 0 h this week, course-linked) ranks above Isha (4 h this week). Approving Kabir moves Isha to the waitlist with an explanation. If Kabir then cancels (sign in as Kabir), Isha is promoted back to review automatically.

Weekly caps: book the printer several times as one student; the fourth booking in a week, or anything past 6 hours, is blocked with the rule shown.

## Disputes and strikes

As **Prof. Sharma** (manager): Incidents → the resolved nozzle incident shows a past strike with its reason. To try one: as **Ms. Kapoor**, open the returned camera booking → Report a problem. As **Admin**, resolve it; choosing to record a strike is a separate, explicit decision.

## Other things to try

- **Overrides**: a blocked request can only be approved by a department manager, and the register marks it as an override.
- **Pooled resources**: the Arduino kits have 10 units; quantity is checked per slot.
- **Opening hours and blackout days**: the seminar hall needs 48 h notice, closes at weekends and is blacked out for the tech fest.
- **Course link**: the seminar hall needs a registered course. Try a made-up code such as ZZ-000 (refused), then ECE-304 (accepted).
- **Audit log** (manager or admin): every action across the system, written by the database.
- **Admin → Reset demo data** restores the starting state at any time.

## Phones

- **Android**: install the APK from the link in the submission.
- **iPhone**: install *Expo Go* from the App Store and scan the QR code in the submission.
