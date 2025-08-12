export function Card({ title, right, children, className="" }) {
    return (
      <section className={`card ${className}`}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          {title ? <h3 className="sectionTitle">{title}</h3> : <span />}
          {right || null}
        </div>
        {children}
      </section>
    );
  }
  
  export function StatKV({ label, value }) {
    return (
      <div className="kv">
        <span className="muted">{label}</span>
        <span>{value ?? "—"}</span>
      </div>
    );
  }
  
  export function Button({ variant="default", ...props }) {
    const cls = variant === "ghost" ? "btn ghost" : variant === "secondary" ? "btn secondary" : "btn";
    return <button className={cls} {...props} />;
  }
  