#if DEBUG
    import UsualMailKit

    /// The sample as the onboarding tour's clips show it (`-UsualMailTour YES`, made by `apps/scripts/make-tour.sh`):
    /// every inbox syncing well, nothing left for the AI, and a summary on every mail, so no warning, note or opening
    /// words take the eye from the feature a clip shows. Debug builds only; the sample itself stays as core has it.
    extension SampleData {
        static var tour: SampleData {
            var data = SampleData.bundled
            for index in data.inboxes.indices {
                data.inboxes[index].status = .ok
                data.inboxes[index].statusDetail = nil
                data.inboxes[index].statusReason = nil
                data.inboxes[index].firstSync = nil
            }
            data.aiStatus.pending = 0
            for index in data.threads.indices where (data.threads[index].summary ?? "").isEmpty {
                data.threads[index].summary = tourSummaries[data.threads[index].id]
            }
            return data
        }

        /// What the AI would have said of the sample's mail that has no summary yet.
        private static let tourSummaries: [String: String] = [
            "thr_14": "Can't make Thursday; asks to move the call to Friday at the same time.",
            "thr_15": "Your Quillpad sign-in code, valid for ten minutes.",
            "thr_16": "Sent the three design directions; asks which one to take forward.",
            "thr_11": "Two items are on their way and arrive on Wednesday.",
            "thr_12": "Dinner at theirs on Saturday at seven; bring wine if you like.",
            "thr_26": "The sale is over, but here is 15% off anyway.",
            "thr_27": "Asks for fifteen minutes this week to talk about your sales pipeline.",
            "thr_28": "Follows up on an offer to write a guest post for your blog.",
        ]
    }
#endif
