'use client';
import { Component, type ReactNode } from 'react';
import { areaLabel, type Area } from './areas';

type Props = { area: Area; goHome: () => void; children: ReactNode };
type State = { failed: boolean };
export class AreaErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State { return { failed: true }; }
  componentDidUpdate(previous: Props) {
    if (previous.area !== this.props.area && this.state.failed) this.setState({ failed: false });
  }
  render() {
    if (this.state.failed) return <section role="alert" className="area-error">
      <h1>{areaLabel(this.props.area)}</h1>
      <p>Something in {areaLabel(this.props.area)} failed to draw. The rest of the app still works.</p>
      <button className="button secondary" onClick={() => this.setState({ failed: false })}>Try again</button>
      {this.props.area === 'home' ? <button className="button primary" onClick={() => window.location.reload()}>Reload Home</button> : <button className="button primary" onClick={this.props.goHome}>Go to Home</button>}
    </section>;
    return this.props.children;
  }
}
