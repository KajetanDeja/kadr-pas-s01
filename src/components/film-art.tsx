export function FilmArt({ kind, title }: { kind: string; title: string }) {
  return <svg viewBox="0 0 600 320" role="img" aria-label={`Ilustracja filmu ${title}`} className="film-art" preserveAspectRatio="xMidYMid meet">
    <defs>
      <radialGradient id={`${kind}-glow`}><stop stopColor={kind === "orbit" ? "#a4b0b4" : kind === "city" ? "#f6a06c" : "#d7d2a0"}/><stop offset="1" stopColor={kind === "orbit" ? "#23353c" : kind === "city" ? "#3c242b" : "#152b28"}/></radialGradient>
      <linearGradient id={`${kind}-shade`} x2="0" y2="1"><stop stopColor="#060b0c" stopOpacity="0"/><stop offset="1" stopColor="#060b0c" stopOpacity=".9"/></linearGradient>
      <filter id={`${kind}-blur`}><feGaussianBlur stdDeviation="13"/></filter>
    </defs>
    <rect width="600" height="320" fill={kind === "orbit" ? "#142027" : kind === "city" ? "#2f252c" : "#102220"}/>
    {kind === "orbit" ? <>
      <circle cx="365" cy="170" r="175" fill={`url(#${kind}-glow)`}/>
      <circle cx="414" cy="132" r="166" fill="#0d181e"/>
      <ellipse cx="324" cy="189" rx="259" ry="28" transform="rotate(-28 324 189)" fill="none" stroke="#afbab2" strokeWidth="2" opacity=".45"/>
      {[ [65,48], [115,103], [204,30], [503,68], [539,233], [152,235], [45,159] ].map(([x,y],i)=><circle key={i} cx={x} cy={y} r="1.2" fill="#cad8d4"/>)}
      <path d="M276 264l14-39 10 4-7 39z" fill="#bcc5bc"/><circle cx="292" cy="220" r="7" fill="#bbc5c0"/>
    </> : kind === "city" ? <>
      <circle cx="360" cy="124" r="120" fill={`url(#${kind}-glow)`} opacity=".85"/>
      {[0,66,136,203,432,505,568].map((x,i)=><g key={x}><rect x={x} y={20+(i%3)*36} width="52" height="300" fill={i%2 ? "#28222b" : "#1c2027"}/>{[0,1,2,3].map(j=><rect key={j} x={x+18} y={73+j*45} width="6" height="13" fill="#c58e6c" opacity=".7"/>)}</g>)}
      <path d="M280 320l58-170h15l76 170" fill="#ad7964" opacity=".4"/>
      <path d="M329 247v39m-9-8 9-22 10 24m-12 5-7 30m11-31 8 30" fill="none" stroke="#171c20" strokeWidth="8" strokeLinecap="round"/><circle cx="330" cy="242" r="7" fill="#171c20"/>
    </> : <>
      <circle cx="298" cy="115" r="170" fill={`url(#${kind}-glow)`} opacity=".7"/>
      <path d="M296 40L100 320h400L315 40" fill="#d6d4b8" opacity=".12" filter={`url(#${kind}-blur)`}/>
      {[40,107,170,443,507,565].map((x,i)=><path key={x} d={`M${x} 0l${i%2?20:-8} 320h24L${x+8} 0z`} fill="#0b1b19"/>)}
      <path d="M272 320l27-137h8l35 137" fill="#bfc3a2" opacity=".4"/><path d="M301 184v31m-3 0-5 25m10-25 6 25" stroke="#152420" strokeWidth="6" strokeLinecap="round"/><circle cx="301" cy="179" r="5" fill="#152420"/>
    </>}
    <rect width="600" height="320" fill={`url(#${kind}-shade)`}/>
    <text x="300" y="284" textAnchor="middle" fill="#e7e9df" fontFamily="Georgia,serif" fontSize={title.length > 14 ? "29" : "42"} letterSpacing="2">{title.toUpperCase()}</text>
  </svg>;
}
