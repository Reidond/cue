using System.Globalization;

namespace Cue;

/// <summary>What `GET /v1/me` says (packages/contract: `Me`): who is signed in, the plan, its limits and the usage this month, and the languages the
/// person reads Cue in.</summary>
public sealed record CueMe(
    CueMe.AccountInfo Account,
    CueMe.PlanInfo Plan,
    CueMe.LimitsInfo Limits,
    CueMe.UsageInfo Usage,
    IReadOnlyList<string>? Languages = null)
{
    /// <summary>The person's languages, in order: none, one, or two (with two, answers and notes come in both).</summary>
    public IReadOnlyList<string> Chosen => Languages ?? [];

    public sealed record AccountInfo(string Id, string Email, string Name, string Role);

    public sealed record PlanInfo(string Id, string Name);

    public sealed record LimitsInfo(double? MonthlyUsd);

    public sealed record FeatureUsage(string Feature, double Usd);

    /// <param name="LimitReached">The month's money is all spent: nothing that costs money starts until it starts over or the limit is raised.</param>
    /// <param name="ByFeature">Dollars by feature, dearest first.</param>
    /// <param name="PeriodStart">Milliseconds since the epoch: the period's start.</param>
    /// <param name="PeriodEnd">Milliseconds since the epoch: when it starts over.</param>
    public sealed record UsageInfo(
        string Month,
        double Usd,
        double AudioSeconds,
        bool LimitReached,
        IReadOnlyList<FeatureUsage> ByFeature,
        double PeriodStart,
        double PeriodEnd)
    {
        /// <summary>"November 1": the day the month starts over, in UTC, as the backend words it.</summary>
        public string RenewsText =>
            DateTimeOffset.FromUnixTimeMilliseconds((long)PeriodEnd).UtcDateTime.ToString("MMMM d", CultureInfo.GetCultureInfo("en-US"));
    }

    /// <summary>The sentence for a spent allowance, as the backend words it (`limit_reached`'s message).</summary>
    public string LimitMessage =>
        $"You've used {Money.Format(Usage.Usd)} of your {Money.Format(Limits.MonthlyUsd ?? Usage.Usd)} Cue plan for this month. It starts over on {Usage.RenewsText} (UTC).";
}

/// <summary>US dollars, as the usage is counted in, in the person's own number format.</summary>
public static class Money
{
    public static string Format(double usd)
    {
        var format = (NumberFormatInfo)CultureInfo.CurrentCulture.NumberFormat.Clone();
        format.CurrencySymbol = "$";
        return usd.ToString("C", format);
    }
}
