import styles from './legal-footer.module.css';

export function LegalFooter() {
  return (
    <footer className={styles.footer}>
      <nav aria-label="Contact and legal information / Kontakt und Rechtliches">
        <a href="https://stadtstack.eu/kontakt" referrerPolicy="no-referrer" aria-label="Kontakt / Contact">Kontakt</a>
        <a href="https://stadtstack.eu/impressum" referrerPolicy="no-referrer" aria-label="Impressum / Legal notice">Impressum</a>
        <a href="https://stadtstack.eu/datenschutz" referrerPolicy="no-referrer" aria-label="Datenschutz / Privacy">Datenschutz</a>
      </nav>
    </footer>
  );
}
