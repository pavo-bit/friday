import 'dart:math';
import '../models/friday_models.dart';

class GeofenceEvaluator {
  /// Compute Haversine distance in meters between two coordinates.
  static double distanceMeters(
    double lat1,
    double lon1,
    double lat2,
    double lon2,
  ) {
    const earthRadius = 6371000.0;
    final dLat = _deg2rad(lat2 - lat1);
    final dLon = _deg2rad(lon2 - lon1);
    final a = sin(dLat / 2) * sin(dLat / 2) +
        cos(_deg2rad(lat1)) * cos(_deg2rad(lat2)) * sin(dLon / 2) * sin(dLon / 2);
    final c = 2 * atan2(sqrt(a), sqrt(1 - a));
    return earthRadius * c;
  }

  static double _deg2rad(double deg) => deg * (pi / 180.0);

  /// Determine whether a coordinate is inside a saved geofence.
  static bool isInsideGeofence(
    double lat,
    double lon,
    SavedLocationItem location,
  ) {
    return distanceMeters(lat, lon, location.latitude, location.longitude) <= location.radiusMeters;
  }
}
