import Foundation

/// What a notification tells of, as the server's AI read it, each fact checked against the mail it was given (core's
/// `NotificationEvent`, docs/contract-ai.md, "Notification events"): what happened or will happen, about what, and
/// when, and which other notifications tell of the same thing. A fact it couldn't check is nil; all of them are nil for
/// a notification that tells of no event (a digest). Plain text, never HTML.
public struct NotificationEvent: Codable, Hashable, Sendable {
    /// What happened or will happen, a short phrase in English whatever the mail's language: "Out for delivery".
    public var status: String?
    /// What or who it concerns, as the mail names it: "Parcel from Fernhill Books". Never the sender's name alone.
    public var about: String?
    /// The moment it matters, as the mail states it, in the mail's own local reading. Nil without a date.
    public var when: When?
    /// An opaque string, the same on one inbox's notification threads that tell of the same thing (one parcel, order,
    /// booking or appointment), so the Notifications tab shows them as one row (docs/contract.md, "Notification
    /// groups"). Nil when the server found nothing to join it by. Only ever compared, never read into.
    public var group: String?

    public init(status: String? = nil, about: String? = nil, when: When? = nil, group: String? = nil) {
        self.status = status
        self.about = about
        self.when = when
        self.group = group
    }

    /// A calendar date with, when the mail gives them, a start time and an end time (a delivery window). No time zone:
    /// it is the mail's own local reading, shown as written and compared with the person's local date as it is, never
    /// converted.
    public struct When: Codable, Hashable, Sendable {
        /// "2026-11-16".
        public var date: String
        /// "15:15", or nil when the mail gives no time.
        public var time: String?
        /// "18:15", the end of a window; only with `time`.
        public var endTime: String?

        public init(date: String, time: String? = nil, endTime: String? = nil) {
            self.date = date
            self.time = time
            self.endTime = endTime
        }

        enum CodingKeys: String, CodingKey {
            case date, time, endTime
        }

        /// Every field is written, null included, as the server writes them.
        public func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(date, forKey: .date)
            try container.encode(time, forKey: .time)
            try container.encode(endTime, forKey: .endTime)
        }
    }

    enum CodingKeys: String, CodingKey {
        case status, about, when, group
    }

    /// The group is read leniently: absent, null, empty or not a string, it is none, and the rest of the event stays.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        about = try container.decodeIfPresent(String.self, forKey: .about)
        when = try container.decodeIfPresent(When.self, forKey: .when)
        let group = try? container.decodeIfPresent(String.self, forKey: .group)
        self.group = group?.isEmpty == false ? group : nil
    }

    /// Every field is written, null included, as the server writes them, so the copy's JSON matches the server's; the
    /// group only when there is one, as the server leaves it out when there is none.
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status, forKey: .status)
        try container.encode(about, forKey: .about)
        try container.encode(when, forKey: .when)
        try container.encodeIfPresent(group, forKey: .group)
    }
}
