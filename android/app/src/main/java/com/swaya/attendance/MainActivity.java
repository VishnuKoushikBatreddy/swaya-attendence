package com.swaya.attendance;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the local native plugins before the bridge starts.
        registerPlugin(GeofencePlugin.class);
        registerPlugin(TrackingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
