import { useEffect, useState } from 'react';
import { Check, MapPin } from 'lucide-react';
import type { CheckinLocation } from '../shared/contracts';

interface Props {
  location: CheckinLocation | null;
  locked: boolean;
  onSave: (location: CheckinLocation) => Promise<void>;
}

export default function LocationEditor({ location, locked, onSave }: Props) {
  const [longitude, setLongitude] = useState('');
  const [latitude, setLatitude] = useState('');
  const [address, setAddress] = useState('');
  useEffect(() => {
    setLongitude(location === null ? '' : String(location.longitude));
    setLatitude(location === null ? '' : String(location.latitude));
    setAddress(location?.address ?? '');
  }, [location?.longitude, location?.latitude, location?.address]);
  const dirty = location === null || longitude.trim() === '' || latitude.trim() === '' || Number(longitude) !== location.longitude || Number(latitude) !== location.latitude || address.trim() !== location.address;

  return <section className="panel coordinate-panel" data-testid="location-editor">
    <div className="section-header"><div><h2>签到位置</h2><p>填写高德地图（GCJ-02）坐标，经度在前、纬度在后。保存后用于手动和定时签到。</p></div><MapPin size={21} /></div>
    <form onSubmit={event => {
      event.preventDefault();
      void onSave({ longitude: Number(longitude), latitude: Number(latitude), address: address.trim() });
    }}>
      <div className="coordinate-fields">
        <label htmlFor="checkin-longitude">经度<input id="checkin-longitude" data-testid="location-longitude" type="number" step="any" min="-180" max="180" required disabled={locked} placeholder="-180 ～ 180" value={longitude} onChange={event => setLongitude(event.target.value)} /></label>
        <label htmlFor="checkin-latitude">纬度<input id="checkin-latitude" data-testid="location-latitude" type="number" step="any" min="-90" max="90" required disabled={locked} placeholder="-90 ～ 90" value={latitude} onChange={event => setLatitude(event.target.value)} /></label>
        <label htmlFor="checkin-address">地点名称<input id="checkin-address" data-testid="location-address" type="text" maxLength={500} required disabled={locked} placeholder="填写所选地点" value={address} onChange={event => setAddress(event.target.value)} /></label>
      </div>
      <div className="settings-save"><span data-testid="location-status">{location === null ? '尚未保存签到位置，请填写并保存。' : dirty ? '修改后请保存；签到使用上次保存的位置。' : `已保存：${location?.address} · ${longitude}, ${latitude}`}</span><button type="submit" data-testid="save-location" className="button secondary" disabled={locked || !dirty || !longitude.trim() || !latitude.trim() || !address.trim()}><Check size={16} />保存坐标</button></div>
    </form>
  </section>;
}
