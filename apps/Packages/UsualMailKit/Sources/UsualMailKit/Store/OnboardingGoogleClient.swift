import Foundation

extension Onboarding {
    /// The app's own words in the guided set-up of the server's Google client (`GoogleClientSetup`), shown where Sign
    /// in with Google would be while the server has no client. The prompt, its note, the steps and why the client can't
    /// be given from here are the server's words, never these.
    public enum GoogleClient {
        /// Above the two paths.
        public static let lead =
            "Your server can't sign in to Google yet. It needs a Google client of its own: you make it once at Google "
            + "Cloud, then give your server the file Google downloads."

        /// The two paths, the agent's first and chosen.
        public static let agentPath = "Let my agent do it"
        public static let byHandPath = "Do it myself"

        /// The agent's path, after the server's note on the prompt (which says how to sign in, fill it in and hand it
        /// over, and what stays with the person): only what the note doesn't say.
        public static let agentLine =
            "Your agent creates the Google client and downloads its file. Then give that file to your server below."
        public static let copyPrompt = "Copy the prompt"
        /// What a copy button says for a moment after copying.
        public static let copied = "Copied"
        /// The toggle that shows the prompt's text.
        public static let seePrompt = "See the prompt"

        /// A step's link to its console page.
        public static let open = "Open"

        /// The end of both paths.
        public static let fileTitle = "Give the file to your server"
        /// In the drop area, on the Mac.
        public static let dropHere = "Drop the file here, or choose it."
        public static let chooseFile = "Choose file…"
        public static let fileNote = "It's the JSON file Google downloaded. Its name starts with client_secret_."
        public static let sending = "Sending…"
        /// Refused before sending: more than `GoogleClientFile.maxBytes`.
        public static let tooLarge =
            "That file is too large to be a Google client file, so it wasn't sent. Choose the JSON file Google "
            + "downloaded."
        public static let unreadable = "That file couldn't be read, so it wasn't sent. Choose it again."
        /// Before why, when the server couldn't be reached.
        public static let notSent = "The file wasn't sent."
        /// After the server's words, when it already has a client and the set-up said one may be given.
        public static let replace = "Replace it"
        public static let cancel = "Cancel"
        /// Under Sign in with Google once the server has its client, from this device or from elsewhere.
        public static let saved = "Your server has its Google client."
        /// The server kept the file but still has no client it can use (its note, above, says why when it says).
        public static let keptUnused = "Your server kept the file, but it still has no Google client it can use."

        /// Before why, when the set-up couldn't be had from the server; with Try again.
        public static let notLoaded = "Your server couldn't say how to set up its Google client."
        /// A server older than the guided set-up (the approved words for a server without a Google client).
        public static let older =
            "Your server can't sign in to Google yet. Give it a Google client first; the setup guide shows how."
        /// A server that sent neither a prompt nor steps nor why.
        public static let empty = "Your server sent no steps for setting up its Google client."

        /// The copy buttons' names for VoiceOver.
        public static func copyLabel(_ what: String) -> String { "Copy \(what)" }
        /// A step's Open link's name for VoiceOver.
        public static func openLabel(_ title: String) -> String { "Open \(title) at Google Cloud" }
    }
}
